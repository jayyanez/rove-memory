import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import { TEST_REMOTE_VARIABLE, parseArguments, parseProjectConfig } from '../rove-memory.mjs';
import {
  createFixture,
  expectOk,
  git,
  originFile,
  runScript,
  temporaryDirectory,
  useLeaseFixtures,
} from './fixture.mjs';

useLeaseFixtures();

const BIN = fileURLToPath(new URL('../bin/rove-memory.mjs', import.meta.url));

function manifest(roveMemory) {
  return JSON.stringify({ name: 'project', roveMemory });
}

describe('project configuration', () => {
  it('reads the project name and memory remote from package.json', () => {
    expect(parseProjectConfig(manifest({ project: 'Garden', remote: 'https://github.com/example-owner/garden-agent-memory.git' })))
      .toEqual({ project: 'Garden', remote: 'https://github.com/example-owner/garden-agent-memory.git' });
    expect(parseProjectConfig(manifest({ project: 'lab-tools', remote: 'git@github.com:example-owner/lab-tools-agent-memory.git' })).remote)
      .toBe('git@github.com:example-owner/lab-tools-agent-memory.git');
    expect(parseProjectConfig(manifest({ project: 'Kite works_2.0', remote: 'ssh://git@github.com/example-owner/x.git' })).project)
      .toBe('Kite works_2.0');
  });

  it('refuses a missing or malformed configuration with a message that says what to add', () => {
    expect(() => parseProjectConfig('{ not json', 'package.json')).toThrow(/not valid JSON/);
    expect(() => parseProjectConfig(JSON.stringify({ name: 'x' }))).toThrow(/has no "roveMemory" object; add \{ "project"/);
    expect(() => parseProjectConfig(manifest(['https://github.com/a/b.git']))).toThrow(/has no "roveMemory" object/);
    expect(() => parseProjectConfig('null')).toThrow(/has no "roveMemory" object/);
  });

  it('refuses a project name that could not be a label', () => {
    const remote = 'https://github.com/example-owner/x.git';
    for (const project of ['', ' leading space', '../escape', 'a'.repeat(65), 'line\nbreak', 7]) {
      expect(() => parseProjectConfig(manifest({ project, remote }))).toThrow(/"roveMemory\.project"/);
    }
  });

  it('accepts only network Git URLs without embedded credentials', () => {
    for (const remote of [
      'http://github.com/example-owner/x.git',
      'https://token@github.com/example-owner/x.git',
      'https://user:secret@github.com/example-owner/x.git',
      'C:\\memory\\origin.git',
      '/srv/memory.git',
      'file:///srv/memory.git',
      'https://github.com',
      'git@github.com:/x.git',
      '',
    ]) {
      expect(() => parseProjectConfig(manifest({ project: 'X', remote }))).toThrow(/"roveMemory\.remote"/);
    }
  });
});

describe('package-manager separators', () => {
  it('ignores a leading separator and one in an option position, but keeps it as a value', () => {
    expect(parseArguments(['--', 'status', '--agent', 'claude'])).toMatchObject({ command: 'status', agentId: 'claude' });
    expect(parseArguments(['sync', '--', '--agent', 'claude'])).toMatchObject({ command: 'sync', agentId: 'claude' });
    expect(parseArguments(['sync', '--agent', 'claude', '--message', '--'])).toMatchObject({ message: '--' });
    expect(() => parseArguments(['--'])).toThrow(/Usage: rove-memory/);
  });
});

describe('the configured project in a real checkout', () => {
  it('names the project in the bootstrap file, its commit, a default sync message and status', () => {
    const fixture = createFixture({ config: { project: 'Atlas', remote: 'https://github.com/example/atlas-agent-memory.git' } });
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    expect(originFile(fixture, 'codex/MEMORY.md')).toMatch(/^# codex memory for Atlas\n/);
    expect(git(['log', '-1', '--format=%an %s'], fixture.memory)).toBe('Codex codex: initialize Atlas memory folder');

    const status = expectOk(runScript(fixture, ['status', '--agent', 'codex']));
    expect(status.out).toMatch(/Project: Atlas \(memory remote /);
    expect(status.out).toMatch(/Canonical checkout: /);

    const lease = runScript(fixture, ['edit', '--agent', 'codex']);
    const token = lease.out.match(/Lease token: ([0-9a-f-]{36})/)[1];
    expect(lease.out).toMatch(/Publish with: pnpm memory sync --agent codex --lease /);
    writeFileSync(path.join(fixture.memory, 'codex', 'MEMORY.md'), '# codex memory for Atlas\n\n- a fact\n');
    expectOk(runScript(fixture, ['sync', '--agent', 'codex', '--lease', token]));
    expect(git(['log', '-1', '--format=%s'], fixture.memory)).toBe('codex: update Atlas memory');
  });

  it('refuses a memory checkout cloned from another remote than the configured one', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const elsewhere = path.join(temporaryDirectory('rove-memory-elsewhere-'), 'origin.git');
    process.env[TEST_REMOTE_VARIABLE] = elsewhere;

    for (const argv of [['status', '--agent', 'claude'], ['setup', '--agent', 'claude'], ['edit', '--agent', 'claude']]) {
      const run = runScript(fixture, argv);
      expect(run.ok).toBe(false);
      expect(run.error).toMatch(/Refusing unexpected memory remote/);
    }
  });

  it('refuses every command in a checkout whose package.json has no configuration, before touching anything', () => {
    const fixture = createFixture();
    writeFileSync(path.join(fixture.checkout, 'package.json'), '{ "name": "unconfigured" }\n');
    for (const command of ['setup', 'status', 'edit']) {
      const run = runScript(fixture, [command, '--agent', 'claude']);
      expect(run.ok).toBe(false);
      expect(run.error).toMatch(/has no "roveMemory" object/);
    }
    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', '00000000-0000-4000-8000-000000000000']);
    expect(sync.error).toMatch(/has no "roveMemory" object/);
    expect(existsSync(fixture.memory)).toBe(false);
    expect(existsSync(path.join(fixture.checkout, '.claude'))).toBe(false);
  });
});

describe('the command line', () => {
  it('runs through the bin entry, accepts a leading separator, and exits 1 with the message on a refusal', () => {
    const fixture = createFixture();
    const env = { ...process.env, [TEST_REMOTE_VARIABLE]: fixture.origin };
    const ok = spawnSync(process.execPath, [BIN, '--', 'setup', '--agent', 'claude'], { cwd: fixture.checkout, env, encoding: 'utf8', windowsHide: true });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/created and published/);

    const refused = spawnSync(process.execPath, [BIN, 'sync', '--agent', 'claude'], { cwd: fixture.checkout, env, encoding: 'utf8', windowsHide: true });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/sync requires --lease/);
  });
});
