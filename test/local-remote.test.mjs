/**
 * 1.1: the memory remote can live in the repository's local Git
 * configuration instead of package.json (so a public project does not publish
 * the address of its private memory), and the lock and lease files can be
 * named per project (so a project can share them with an older tool).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import { LOCAL_REMOTE_KEY, chooseRemote, main, parseArguments, parseProjectConfig } from '../rove-memory.mjs';
import {
  FIXTURE_CONFIG,
  acquire,
  createFixture,
  expectOk,
  git,
  originFile,
  runScript,
  useLeaseFixtures,
} from './fixture.mjs';

useLeaseFixtures();

const PUBLIC_REMOTE = 'https://github.com/example-owner/public-agent-memory.git';

function manifest(roveMemory) {
  return JSON.stringify({ name: 'project', roveMemory });
}

function localSetting(fixture) {
  try {
    return git(['config', '--local', '--get', LOCAL_REMOTE_KEY], fixture.checkout);
  } catch {
    return null;
  }
}

describe('configuration without a published remote', () => {
  it('accepts a package.json with no remote, and a valid state name', () => {
    expect(parseProjectConfig(manifest({ project: 'Public' }))).toEqual({ project: 'Public', remote: null, stateName: 'rove-memory' });
    expect(parseProjectConfig(manifest({ project: 'Legacy', stateName: 'legacy-agent-memory' })).stateName).toBe('legacy-agent-memory');
    for (const stateName of ['', 'Upper', '../escape', 'a/b', 'x'.repeat(65), 7]) {
      expect(() => parseProjectConfig(manifest({ project: 'X', stateName }))).toThrow(/"roveMemory\.stateName"/);
    }
  });

  it('chooses the configured or the local remote, refuses two different ones or none, and never echoes an invalid local value', () => {
    expect(chooseRemote(PUBLIC_REMOTE, null)).toBe(PUBLIC_REMOTE);
    expect(chooseRemote(null, PUBLIC_REMOTE)).toBe(PUBLIC_REMOTE);
    expect(chooseRemote(PUBLIC_REMOTE, 'git@github.com:example-owner/public-agent-memory.git')).toBe(PUBLIC_REMOTE);
    expect(() => chooseRemote(PUBLIC_REMOTE, 'https://github.com/example-owner/other.git')).toThrow(/Two different memory remotes/);
    expect(() => chooseRemote(null, null)).toThrow(/No memory remote is configured\. Run setup once on this computer with --remote/);
    const invalid = 'https://token-SECRET@github.com/o/m.git';
    let message = '';
    try {
      chooseRemote(null, invalid);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/is not an https:\/\/ or SSH Git URL without credentials/);
    expect(message).not.toMatch(/SECRET/);
  });

  it('takes --remote for setup only, and only with a value', () => {
    expect(parseArguments(['setup', '--agent', 'claude', '--remote', PUBLIC_REMOTE])).toMatchObject({ remote: PUBLIC_REMOTE });
    expect(() => parseArguments(['status', '--agent', 'claude', '--remote', PUBLIC_REMOTE])).toThrow(/--remote applies to setup only/);
    expect(() => parseArguments(['setup', '--agent', 'claude', '--remote'])).toThrow(/--remote requires/);
    expect(() => parseArguments(['setup', '--remote', '--agent', 'claude'])).toThrow(/--remote requires/);
  });
});

describe('a project that keeps its remote in local Git configuration', () => {
  it('setup without a remote says how to give one; setup --remote stores it and every command then uses it', () => {
    const fixture = createFixture({ config: { project: 'Public' } });
    const refused = runScript(fixture, ['setup', '--agent', 'claude']);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/No memory remote is configured/);
    expect(existsSync(fixture.memory)).toBe(false);

    expect(runScript(fixture, ['setup', '--agent', 'claude', '--remote', 'https://token@github.com/o/m.git']).error)
      .toMatch(/--remote must be an https:\/\/ or SSH Git URL without credentials/);
    expect(localSetting(fixture)).toBeNull();

    expectOk(runScript(fixture, ['setup', '--agent', 'claude', '--remote', PUBLIC_REMOTE]));
    expect(localSetting(fixture)).toBe(PUBLIC_REMOTE);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/claude memory for Public/);
    const status = expectOk(runScript(fixture, ['status', '--agent', 'claude']));
    expect(status.out).toMatch(/from the local Git setting rove-memory\.remote/);

    // The same remote again is fine; a different one is refused, not replaced.
    expectOk(runScript(fixture, ['setup', '--agent', 'claude', '--remote', PUBLIC_REMOTE]));
    const other = runScript(fixture, ['setup', '--agent', 'claude', '--remote', 'https://github.com/example-owner/other-agent-memory.git']);
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/already stores rove-memory\.remote/);
    expect(localSetting(fixture)).toBe(PUBLIC_REMOTE);

    // A lease and a publish work as with a configured remote.
    const token = acquire(fixture);
    expectOk(runScript(fixture, ['release', '--agent', 'claude', '--lease', token]));
  });

  it('a linked worktree shares the stored remote', () => {
    const fixture = createFixture({ config: { project: 'Public' } });
    expectOk(runScript(fixture, ['setup', '--agent', 'claude', '--remote', PUBLIC_REMOTE]));
    const worktree = path.join(path.dirname(fixture.checkout), 'linked');
    git(['worktree', 'add', '-q', worktree], fixture.checkout);
    const lines = [];
    const log = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    try {
      main(['status', '--agent', 'claude'], worktree);
    } finally {
      console.log = log;
    }
    expect(lines.join('\n')).toMatch(/from the local Git setting/);
  });

  it('refuses --remote when package.json names a different remote, and accepts the same one', () => {
    const fixture = createFixture();
    const different = runScript(fixture, ['setup', '--agent', 'claude', '--remote', PUBLIC_REMOTE]);
    expect(different.ok).toBe(false);
    expect(different.error).toMatch(/--remote differs from "roveMemory\.remote" in package\.json/);
    expectOk(runScript(fixture, ['setup', '--agent', 'claude', '--remote', FIXTURE_CONFIG.remote]));
    expect(localSetting(fixture)).toBeNull();
  });

  it('refuses two different remotes, one in package.json and one stored locally', () => {
    const fixture = createFixture();
    git(['config', '--local', LOCAL_REMOTE_KEY, PUBLIC_REMOTE], fixture.checkout);
    const status = runScript(fixture, ['status', '--agent', 'claude']);
    expect(status.ok).toBe(false);
    expect(status.error).toMatch(/Two different memory remotes are configured/);
  });
});

describe('a project that names its lock and lease', () => {
  it('uses <stateName>.lock and <stateName>.lease, and a lease there excludes a second writer', () => {
    const fixture = createFixture({ config: { ...FIXTURE_CONFIG, stateName: 'legacy-agent-memory' } });
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    acquire(fixture);
    const gitDirectory = path.join(fixture.checkout, '.git');
    expect(existsSync(path.join(gitDirectory, 'legacy-agent-memory.lease'))).toBe(true);
    expect(existsSync(path.join(gitDirectory, 'rove-memory.lease'))).toBe(false);
    expect(existsSync(path.join(gitDirectory, 'legacy-agent-memory.lock'))).toBe(false);

    const second = runScript(fixture, ['edit', '--agent', 'codex']);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/live memory edit lease already exists/);
  });
});
