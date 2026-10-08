/**
 * Shared fixture for the edit-lease integration suites (README.md, "The edit
 * lease").
 *
 * Every suite drives the real library against real Git: a bare "origin", a
 * temporary project checkout whose `.agent-memory/` the library clones from
 * it, and a second clone standing in for another machine. Sessions on one
 * machine are modelled by calling the library twice from the same checkout
 * with different tokens and holder pids — exactly what two agent sessions in
 * two linked worktrees do. The suites are split across files so the test
 * runner can isolate them; each fixture is fully isolated on disk.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import {
  LEASE_FILE,
  LEASE_TTL_VARIABLE,
  TEST_REMOTE_VARIABLE,
  main,
  resetProcessStartTimeCache,
} from '../rove-memory.mjs';

/** The project configuration every fixture checkout carries. */
export const FIXTURE_CONFIG = {
  project: 'Fixture',
  remote: 'https://github.com/example/fixture-agent-memory.git',
};

const temporaryDirectories = [];
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

export function git(args, cwd, input) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...AUTHOR_ENV },
    input,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

export function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** A bare origin with README.md on main, a project checkout, and a second clone. */
export function createFixture({ config = FIXTURE_CONFIG } = {}) {
  const root = temporaryDirectory('rove-memory-lease-');
  const origin = path.join(root, 'origin.git');
  git(['init', '--bare', '--initial-branch=main', origin], root);

  const seed = path.join(root, 'seed');
  git(['clone', '-q', origin, seed], root);
  writeFileSync(path.join(seed, 'README.md'), '# memory\n');
  git(['add', 'README.md'], seed);
  git(['commit', '-q', '-m', 'init'], seed);
  git(['push', '-q', 'origin', 'HEAD:main'], seed);

  const checkout = path.join(root, 'project');
  git(['init', '-q', '--initial-branch=main', checkout], root);
  writeFileSync(path.join(checkout, 'README.md'), '# project\n');
  writeFileSync(
    path.join(checkout, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, roveMemory: config }, null, 2)}\n`,
  );
  git(['add', 'README.md', 'package.json'], checkout);
  git(['commit', '-q', '-m', 'project'], checkout);

  const otherMachine = path.join(root, 'other-machine');
  git(['clone', '-q', origin, otherMachine], root);

  process.env[TEST_REMOTE_VARIABLE] = origin;
  return {
    origin,
    checkout,
    memory: path.join(checkout, '.agent-memory'),
    leaseFile: path.join(checkout, '.git', LEASE_FILE),
    otherMachine,
  };
}

export function runScript(fixture, argv) {
  const out = [];
  const warn = [];
  const log = console.log;
  const warning = console.warn;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.warn = (...args) => { warn.push(args.join(' ')); };
  try {
    main(argv, fixture.checkout);
    return { ok: true, error: '', out: out.join('\n'), warn: warn.join('\n') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), out: out.join('\n'), warn: warn.join('\n') };
  } finally {
    console.log = log;
    console.warn = warning;
  }
}

export function expectOk(run) {
  if (!run.ok) throw new Error(`expected success, got: ${run.error}`);
  return run;
}

export function tokenOf(run) {
  const match = run.out.match(/Lease token: ([0-9a-f-]{36})/);
  if (!match) throw new Error(`no lease token in output:\n${run.out}`);
  return match[1];
}

export function readLease(fixture) {
  return JSON.parse(readFileSync(fixture.leaseFile, 'utf8'));
}

export function originFile(fixture, relative) {
  const result = spawnSync('git', ['show', `main:${relative}`], { cwd: fixture.origin, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

/** Publish a change from "another machine" (or a session that bypassed the lease). */
export function publishFromOtherMachine(fixture, relative, contents, message = 'other machine') {
  git(['pull', '-q', '--ff-only', 'origin', 'main'], fixture.otherMachine);
  const file = path.join(fixture.otherMachine, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  git(['add', '--all'], fixture.otherMachine);
  git(['commit', '-q', '-m', message], fixture.otherMachine);
  git(['push', '-q', 'origin', 'HEAD:main'], fixture.otherMachine);
}

export function acquire(fixture, agent = 'claude', extra = []) {
  return tokenOf(expectOk(runScript(fixture, ['edit', '--agent', agent, '--holder-pid', String(process.pid), ...extra])));
}

/** A pid that certainly no longer exists: a child that already exited. */
export function exitedPid() {
  const child = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true });
  return child.pid ?? 4_000_000;
}

export const WRONG_TOKEN = '00000000-0000-4000-8000-000000000000';

const STUBBED_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', ...Object.keys(AUTHOR_ENV)];

/** Registers the per-test environment reset and temp-dir cleanup. */
export function useLeaseFixtures() {
  let saved = {};
  beforeEach(() => {
    saved = Object.fromEntries(STUBBED_ENV.map((key) => [key, process.env[key]]));
    // Give the real library a configured identity without borrowing developer
    // settings. Git's per-command author overrides must still take precedence.
    const configRoot = temporaryDirectory('rove-memory-git-config-');
    const config = path.join(configRoot, 'gitconfig');
    writeFileSync(config, '[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    for (const key of Object.keys(AUTHOR_ENV)) delete process.env[key];
    delete process.env[LEASE_TTL_VARIABLE];
    // The library caches pid probes per process (the CLI is one-shot); a test
    // file runs many invocations in one process, so start each case fresh.
    resetProcessStartTimeCache();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env[TEST_REMOTE_VARIABLE];
    delete process.env[LEASE_TTL_VARIABLE];
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
