import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import { TEST_REMOTE_VARIABLE, classifyLease, parseArguments, probeProcess, processStartTime, resolveMemoryRemote, validateCommittedTree } from '../rove-memory.mjs';
import {
  WRONG_TOKEN,
  acquire,
  createFixture,
  exitedPid,
  expectOk,
  git,
  originFile,
  readLease,
  runScript,
  useLeaseFixtures,
} from './fixture.mjs';

useLeaseFixtures();

describe('lease argument contract', () => {
  it('requires a token for release and renew, and validates the holder pid', () => {
    expect(() => parseArguments(['release', '--agent', 'claude'])).toThrow(/requires --lease/);
    expect(() => parseArguments(['edit', '--agent', 'claude', '--renew'])).toThrow(/requires --lease/);
    expect(() => parseArguments(['edit', '--agent', 'claude', '--holder-pid', 'abc'])).toThrow(/positive integer/);
    expect(() => parseArguments(['sync', '--agent', 'claude', '--lease', 'nope'])).toThrow(/token printed by edit/);
    expect(parseArguments(['edit', '--agent', 'claude', '--holder-pid', '42', '--reclaim-stale'])).toMatchObject({
      command: 'edit',
      holderPid: 42,
      reclaimStale: true,
    });
  });
});

describe('memory remote override boundary', () => {
  it('honours ROVE_MEMORY_TEST_REMOTE only for an absolute path on this computer', () => {
    const configured = 'https://github.com/example/project-agent-memory.git';
    const local = process.platform === 'win32' ? 'C:\\tmp\\origin.git' : '/tmp/origin.git';
    expect(resolveMemoryRemote(configured, {})).toBe(configured);
    expect(resolveMemoryRemote(configured, { [TEST_REMOTE_VARIABLE]: local })).toBe(local);
    expect(resolveMemoryRemote(configured, { [TEST_REMOTE_VARIABLE]: 'https://example.invalid/evil.git' })).toBe(configured);
    expect(resolveMemoryRemote(configured, { [TEST_REMOTE_VARIABLE]: 'git@example.invalid:evil.git' })).toBe(configured);
    expect(resolveMemoryRemote(configured, { [TEST_REMOTE_VARIABLE]: 'relative/origin.git' })).toBe(configured);
    expect(resolveMemoryRemote(configured, { [TEST_REMOTE_VARIABLE]: '   ' })).toBe(configured);
    expect(resolveMemoryRemote(configured, { [TEST_REMOTE_VARIABLE]: '\\\\server\\share\\origin.git' })).toBe(configured);
    expect(resolveMemoryRemote(configured, { [TEST_REMOTE_VARIABLE]: '//server/share/origin.git' })).toBe(configured);
    expect(resolveMemoryRemote(configured, { [TEST_REMOTE_VARIABLE]: 'file://server/share/origin.git' })).toBe(configured);
  });
});

describe('committed-tree validation', () => {
  it('rejects a committed non-Markdown file even when its name contains a tab, and accepts a valid tree', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    expect(validateCommittedTree(fixture.memory, 'HEAD', 'claude')).toMatchObject({ files: 1 });

    // Build the hostile commit from raw objects (neither Windows nor git's
    // index would accept the path): a blob whose committed path is
    // "claude/x.md<TAB>sneaky.bin". mktree/commit-tree do not validate paths.
    const blob = git(['hash-object', '-w', '--stdin'], fixture.memory, 'binary');
    const memoryBlob = git(['rev-parse', 'HEAD:claude/MEMORY.md'], fixture.memory);
    const readmeBlob = git(['rev-parse', 'HEAD:README.md'], fixture.memory);
    const NUL = '\u0000';
    const claudeTree = git(['mktree', '-z'], fixture.memory, `100644 blob ${memoryBlob}\tMEMORY.md${NUL}100644 blob ${blob}\tx.md\tsneaky.bin${NUL}`);
    const rootTree = git(['mktree', '-z'], fixture.memory, `100644 blob ${readmeBlob}\tREADME.md${NUL}040000 tree ${claudeTree}\tclaude${NUL}`);
    const hostile = git(['commit-tree', rootTree, '-p', 'HEAD', '-m', 'hostile'], fixture.memory);
    expect(git(['ls-tree', '-r', '-z', '--name-only', hostile, '--', 'claude'], fixture.memory)).toMatch(/x\.md\tsneaky\.bin/);
    expect(() => validateCommittedTree(fixture.memory, hostile, 'claude')).toThrow(/control characters/);
  });
});

describe('lease liveness rule', () => {
  it('keeps a holder-pid lease live past the TTL while the process is alive, stale when it is gone', () => {
    // Native premise measured here, not assumed: this host's probe reads the
    // start time of a live same-user process.
    expect(probeProcess(process.pid)).toMatchObject({ state: 'alive', start: expect.any(String) });
    const start = processStartTime(process.pid);
    expect(start).toBeTruthy();
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const alive = { agent: 'claude', token: 't', holderPid: process.pid, holderStart: start, createdAt: old, renewedAt: old };
    expect(classifyLease(alive, { ttlMs: 1 })).toMatchObject({ state: 'live', mode: 'holder-pid' });

    const gone = { ...alive, holderPid: exitedPid(), holderStart: 'never' };
    expect(probeProcess(gone.holderPid)).toEqual({ state: 'gone', start: null });
    expect(classifyLease(gone, { ttlMs: 1 })).toMatchObject({ state: 'stale', mode: 'holder-pid' });

    const reused = { ...alive, holderStart: 'a different start time' };
    expect(classifyLease(reused)).toMatchObject({ state: 'stale', reason: expect.stringMatching(/different process/) });
  });

  it('never dispossesses a holder on a probe failure: an existing process with an unreadable start time stays live', () => {
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const lease = { agent: 'claude', token: 't', holderPid: 4242, holderStart: 'recorded', createdAt: old, renewedAt: old };
    const unknown = () => ({ state: 'unknown', start: null });
    expect(classifyLease(lease, { probe: unknown, ttlMs: 1 })).toMatchObject({
      state: 'live',
      mode: 'holder-pid',
      reason: expect.stringMatching(/could not be read/),
    });
    const gone = () => ({ state: 'gone', start: null });
    expect(classifyLease(lease, { probe: gone, ttlMs: 1 })).toMatchObject({ state: 'stale' });
  });

  it('treats a lease without a holder pid as TTL-only', () => {
    const now = Date.parse('2026-08-24T12:00:00.000Z');
    const lease = { agent: 'codex', token: 't', holderPid: null, holderStart: null, createdAt: '2026-08-24T11:00:00.000Z', renewedAt: '2026-08-24T11:50:00.000Z' };
    expect(classifyLease(lease, { now, ttlMs: 30 * 60 * 1000 })).toMatchObject({ state: 'live', mode: 'ttl-only' });
    expect(classifyLease(lease, { now: now + 31 * 60 * 1000, ttlMs: 30 * 60 * 1000 })).toMatchObject({ state: 'stale', mode: 'ttl-only' });
  });
});

describe('portable memory edit lease — core flow (real git)', () => {
  it('setup publishes a brand-new harness folder end to end', () => {
    const fixture = createFixture();
    const run = expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    expect(run.out).toMatch(/created and published/);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/claude memory for Fixture/);
    expect(git(['status', '--porcelain'], fixture.memory)).toBe('');
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('0');
    expect(existsSync(fixture.leaseFile)).toBe(false);

    const status = expectOk(runScript(fixture, ['status', '--agent', 'claude']));
    expect(status.out).toMatch(/Edit lease: none/);
    expect(status.out).toMatch(/Claude auto memory: configured/);
  });

  it('a live lease blocks a second edit, sync without the token, and the wrong token', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    expect(readLease(fixture)).toMatchObject({ agent: 'claude', token, holderPid: process.pid });

    // The same holder process asking again (lost output) gets its token back.
    const again = expectOk(runScript(fixture, ['edit', '--agent', 'claude', '--holder-pid', String(process.pid)]));
    expect(again.out).toMatch(/already holds the memory edit lease/);
    expect(again.out).toMatch(new RegExp(`Lease token: ${token}`));

    // A different process of the same harness is still locked out.
    const second = runScript(fixture, ['edit', '--agent', 'claude']);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/live memory edit lease already exists/);
    expect(second.error).toMatch(new RegExp(`pid ${process.pid}`));

    const otherHarness = runScript(fixture, ['edit', '--agent', 'codex']);
    expect(otherHarness.ok).toBe(false);
    expect(otherHarness.error).toMatch(/live memory edit lease already exists/);

    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- fact\n');
    const noLease = runScript(fixture, ['sync', '--agent', 'claude']);
    expect(noLease.ok).toBe(false);
    expect(noLease.error).toMatch(/requires --lease/);

    const wrongToken = runScript(fixture, ['sync', '--agent', 'claude', '--lease', WRONG_TOKEN]);
    expect(wrongToken.ok).toBe(false);
    expect(wrongToken.error).toMatch(/not yours/);
    expect(originFile(fixture, 'claude/MEMORY.md')).not.toMatch(/fact/);

    const status = expectOk(runScript(fixture, ['status', '--agent', 'codex']));
    expect(status.out).toMatch(/Edit lease: live \(another harness\)/);
  });

  it('a non-empty authorized sync publishes with attribution and releases the lease', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- durable fact\n');
    writeFileSync(path.join(fixture.memory, 'claude', 'topic.md'), '# topic\n');

    const sync = expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: add fact']));
    expect(sync.out).toMatch(/Published claude memory \(2 files/);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/durable fact/);
    expect(git(['log', '-1', '--format=%an <%ae> %s'], fixture.memory)).toBe('Claude <noreply@anthropic.com> claude: add fact');
    expect(existsSync(fixture.leaseFile)).toBe(false);

    // The released token is dead: another sync with it refuses.
    const again = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/No memory edit lease exists/);
  });

  it('edit refuses a dirty folder and never stages foreign files', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    writeFileSync(path.join(fixture.memory, 'claude', 'draft.md'), '# half written by another session\n');

    const edit = runScript(fixture, ['edit', '--agent', 'claude', '--holder-pid', String(process.pid)]);
    expect(edit.ok).toBe(false);
    expect(edit.error).toMatch(/unsynced changes: claude\/draft\.md/);
    expect(existsSync(fixture.leaseFile)).toBe(false);
    expect(git(['status', '--porcelain'], fixture.memory)).toMatch(/draft\.md/);
  });

  it('release refuses while unsynced edits exist or the token is wrong, then succeeds on a clean folder', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- draft\n');

    const dirty = runScript(fixture, ['release', '--agent', 'claude', '--lease', token]);
    expect(dirty.ok).toBe(false);
    expect(dirty.error).toMatch(/unsynced changes/);
    expect(existsSync(fixture.leaseFile)).toBe(true);

    git(['checkout', '--', 'claude/MEMORY.md'], fixture.memory);
    const wrong = runScript(fixture, ['release', '--agent', 'claude', '--lease', WRONG_TOKEN]);
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/not yours/);

    expectOk(runScript(fixture, ['release', '--agent', 'claude', '--lease', token]));
    expect(existsSync(fixture.leaseFile)).toBe(false);
  });

  it('sync with nothing to publish releases the lease', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    const sync = expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]));
    expect(sync.out).toMatch(/No claude memory changes to publish\. Lease released/);
    expect(existsSync(fixture.leaseFile)).toBe(false);
  });
});
