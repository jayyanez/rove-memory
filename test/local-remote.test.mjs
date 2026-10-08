/**
 * 1.1: the memory remote can live in the repository's local Git
 * configuration instead of package.json (so a public project does not publish
 * the address of its private memory), and the edit lease is named after the
 * memory repository (so every worktree shares it, and so does an earlier tool
 * that used that name).
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import { LOCAL_REMOTE_KEY, chooseRemote, leaseNamespace, main, parseArguments, parseProjectConfig } from '../rove-memory.mjs';
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
  it('accepts a package.json with no remote', () => {
    expect(parseProjectConfig(manifest({ project: 'Public' }))).toEqual({ project: 'Public', remote: null });
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

describe('the lease is named after the memory repository', () => {
  it('derives one name per memory repository that can never be one of Git\'s own files', () => {
    for (const remote of [
      'https://github.com/example-owner/project-agent-memory.git',
      'git@github.com:example-owner/project-agent-memory.git',
      'ssh://git@github.com/example-owner/project-agent-memory',
    ]) {
      expect(leaseNamespace(remote)).toBe('project-agent-memory');
    }
    expect(leaseNamespace('https://example.com/owner/index.git')).toBe('index-memory');
    expect(leaseNamespace('https://example.com/owner/HEAD')).toBe('head-memory');
    expect(leaseNamespace('https://example.com/owner/Weird_Name.Repo.git')).toBe('weird-name-repo-memory');
    expect(leaseNamespace('https://example.com/owner/rove-memory.git')).toBe('rove-memory');
  });

  it('keeps the lease in <memory repository>.lease, and waits for an earlier tool that holds that name\'s lock', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const gitDirectory = path.join(fixture.checkout, '.git');
    const token = acquire(fixture);
    expect(existsSync(path.join(gitDirectory, 'fixture-agent-memory.lease'))).toBe(true);
    expect(existsSync(path.join(gitDirectory, 'rove-memory.lease'))).toBe(false);
    expect(existsSync(path.join(gitDirectory, 'fixture-agent-memory.lock'))).toBe(false);
    expectOk(runScript(fixture, ['release', '--agent', 'claude', '--lease', token]));

    // An earlier tool that locks only <memory repository>.lock is mid-operation.
    writeFileSync(
      path.join(gitDirectory, 'fixture-agent-memory.lock'),
      `${JSON.stringify({ agent: 'codex', operation: 'sync', pid: 1, startedAt: '2026-10-08T00:00:00.000Z' })}\n`,
    );
    const edit = runScript(fixture, ['edit', '--agent', 'claude']);
    expect(edit.ok).toBe(false);
    expect(edit.error).toMatch(/Unable to acquire the memory operation lock at .*fixture-agent-memory\.lock/);
    expect(existsSync(path.join(gitDirectory, 'rove-memory.lock'))).toBe(false);
    expect(existsSync(fixture.leaseFile)).toBe(false);
  });
});

describe('one operation lock per repository', () => {
  it('stores --remote only under the operation lock', () => {
    const fixture = createFixture({ config: { project: 'Public' } });
    const lock = path.join(fixture.checkout, '.git', 'rove-memory.lock');
    writeFileSync(lock, `${JSON.stringify({ agent: 'codex', operation: 'setup', pid: 1, startedAt: '2026-10-08T00:00:00.000Z' })}\n`);
    const setup = runScript(fixture, ['setup', '--agent', 'claude', '--remote', PUBLIC_REMOTE]);
    expect(setup.ok).toBe(false);
    expect(setup.error).toMatch(/Unable to acquire the memory operation lock/);
    expect(localSetting(fixture)).toBeNull();
  });
});
