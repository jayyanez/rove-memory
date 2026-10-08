import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import {
  acquire,
  createFixture,
  expectOk,
  git,
  originFile,
  publishFromOtherMachine,
  readLease,
  runScript,
  useLeaseFixtures,
} from './fixture.mjs';

useLeaseFixtures();

describe('portable memory edit lease — generation checks (real git)', () => {
  it('a same-harness commit that landed locally during the lease (bypass) refuses the sync', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);

    // Another session ignores the lease and commits straight into the shared checkout.
    writeFileSync(path.join(fixture.memory, 'claude', 'bypass.md'), '# bypass\n');
    git(['add', '--all'], fixture.memory);
    git(['commit', '-q', '-m', 'bypass'], fixture.memory);

    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- mine\n');
    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]);
    expect(sync.ok).toBe(false);
    expect(sync.error).toMatch(/same-harness commit landed in the shared checkout/);
    expect(originFile(fixture, 'claude/MEMORY.md')).not.toMatch(/mine/);
  });

  it('a remote same-harness commit refuses the sync, edit --renew rotates the baseline, and the next sync succeeds', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- from this machine\n');

    publishFromOtherMachine(fixture, 'claude/remote.md', '# remote\n');

    const refused = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: local']);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/landed on origin\/main/);
    expect(refused.error).toMatch(/edit --renew/);
    // The holder's commit exists locally and is kept; nothing was pushed.
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('1');
    expect(originFile(fixture, 'claude/MEMORY.md')).not.toMatch(/from this machine/);

    const stillRefused = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]);
    expect(stillRefused.ok).toBe(false);

    const renewed = expectOk(runScript(fixture, ['edit', '--agent', 'claude', '--renew', '--lease', token]));
    expect(renewed.out).toMatch(/baseline rotated/);
    expect(renewed.out).toMatch(/claude\/remote\.md/);
    expect(readLease(fixture).token).toBe(token);

    // A repeated renew (its first output was lost) still discloses the same
    // remote change: the disclosure is anchored to the baseline edited against.
    const repeated = expectOk(runScript(fixture, ['edit', '--agent', 'claude', '--renew', '--lease', token]));
    expect(repeated.out).toMatch(/claude\/remote\.md/);

    // The holder may adjust after re-reading, then publishes on top of the remote commit.
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- from this machine\n- merged with remote\n');
    const published = expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: merged']));
    expect(published.out).toMatch(/Published claude memory/);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/merged with remote/);
    expect(originFile(fixture, 'claude/remote.md')).toMatch(/remote/);
    expect(existsSync(fixture.leaseFile)).toBe(false);
  });

  it('edit --renew keeps unsynced working-tree edits when the remote change does not overlap them, and names the overlap when it does', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- local, not yet synced\n');

    publishFromOtherMachine(fixture, 'claude/remote.md', '# remote\n');
    const renewed = expectOk(runScript(fixture, ['edit', '--agent', 'claude', '--renew', '--lease', token]));
    expect(renewed.out).toMatch(/claude\/remote\.md/);
    expect(git(['status', '--porcelain'], fixture.memory)).toMatch(/claude\/MEMORY\.md/);
    expect(existsSync(path.join(fixture.memory, 'claude', 'remote.md'))).toBe(true);

    publishFromOtherMachine(fixture, 'claude/MEMORY.md', '# claude\n\n- remote rewrite\n');
    const overlap = runScript(fixture, ['edit', '--agent', 'claude', '--renew', '--lease', token]);
    expect(overlap.ok).toBe(false);
    expect(overlap.error).toMatch(/overlap files changed on origin\/main \(claude\/MEMORY\.md\)/);
    expect(git(['status', '--porcelain'], fixture.memory)).toMatch(/claude\/MEMORY\.md/);
  });

  it('another harness publishing in between does not invalidate the lease', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- mine\n');

    publishFromOtherMachine(fixture, 'codex/MEMORY.md', '# codex\n', 'codex: update');

    const sync = expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: mine']));
    expect(sync.out).toMatch(/Published claude memory/);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/mine/);
    expect(originFile(fixture, 'codex/MEMORY.md')).toMatch(/codex/);
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('0');
  });

  it('a push whose acknowledgement was lost is recognised as published, even with a later same-harness commit on top', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- pushed but not acknowledged\n');

    // Force the refusal path so the holder's commit exists locally, then
    // simulate the lost acknowledgement: the remote already has that commit
    // but the client's remote-tracking ref was never advanced.
    publishFromOtherMachine(fixture, 'claude/remote.md', '# remote\n');
    const refused = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: lost ack']);
    expect(refused.ok).toBe(false);
    const holderCommit = git(['rev-parse', 'HEAD'], fixture.memory);
    git(['fetch', '-q', 'origin'], fixture.memory);
    git(['rebase', '-q', 'origin/main'], fixture.memory);
    const rebased = git(['rev-parse', 'HEAD'], fixture.memory);
    expect(rebased).not.toBe(holderCommit);
    writeFileSync(fixture.leaseFile, JSON.stringify({ ...readLease(fixture), commit: rebased }));
    const trackedBefore = git(['rev-parse', 'refs/remotes/origin/main'], fixture.memory);
    git(['push', '-q', 'origin', 'HEAD:main'], fixture.memory);
    git(['update-ref', 'refs/remotes/origin/main', trackedBefore], fixture.memory);
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('1');
    // A later same-harness commit lands on top on the remote.
    publishFromOtherMachine(fixture, 'claude/later.md', '# later\n');

    const sync = expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]));
    expect(sync.out).toMatch(/already on origin\/main/);
    expect(existsSync(fixture.leaseFile)).toBe(false);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/pushed but not acknowledged/);
  });
});
