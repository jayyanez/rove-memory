import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import {
  acquire,
  createFixture,
  exitedPid,
  expectOk,
  git,
  originFile,
  publishFromOtherMachine,
  readLease,
  runScript,
  tokenOf,
  useLeaseFixtures,
} from './fixture.mjs';
import { LEASE_TTL_VARIABLE } from '../rove-memory.mjs';

useLeaseFixtures();

describe('portable memory edit lease — recovery and fencing (real git)', () => {
  it('an edit that lands after the lease was released is adoptable with the released token, not by anyone else', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- published\n');
    expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: published']));
    expect(existsSync(fixture.leaseFile)).toBe(false);

    // The write that slipped in after the release.
    writeFileSync(path.join(fixture.memory, 'claude', 'late.md'), '# late\n');
    const anonymous = runScript(fixture, ['edit', '--agent', 'claude', '--holder-pid', String(process.pid)]);
    expect(anonymous.ok).toBe(false);
    expect(anonymous.error).toMatch(/unsynced changes/);
    const wrong = runScript(fixture, ['edit', '--agent', 'claude', '--lease', '00000000-0000-4000-8000-000000000000']);
    expect(wrong.ok).toBe(false);

    const adopted = expectOk(runScript(fixture, ['edit', '--agent', 'claude', '--lease', token, '--holder-pid', String(process.pid)]));
    expect(adopted.warn).toMatch(/Adopted edits that landed after your previous lease was released/);
    const fresh = tokenOf(adopted);
    expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', fresh, '--message', 'claude: late']));
    expect(originFile(fixture, 'claude/late.md')).toMatch(/late/);
    expect(existsSync(fixture.leaseFile)).toBe(false);
  });

  it('a commit that lands during the push is neither pushed nor orphaned: the exact validated SHA goes out and the lease is kept', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- first\n');
    // A raw commit created while the push runs (a pre-push hook stands in
    // for a concurrent session that bypassed the lease).
    const hook = path.join(fixture.memory, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\nroot="$(git rev-parse --show-toplevel)"\nprintf "# raw\\n" > "$root/claude/raw.md"\ngit add "$root/claude/raw.md"\ngit -c user.name=x -c user.email=x@y commit -q -m raw -- "$root/claude/raw.md"\nexit 0\n', { mode: 0o755 });

    const sync = expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: first']));
    expect(sync.warn).toMatch(/still unpublished; the lease is kept/);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/first/);
    expect(originFile(fixture, 'claude/raw.md')).toBeNull();
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('1');
    expect(existsSync(fixture.leaseFile)).toBe(true);
  });

  it('a write that lands while edit is taking the lease is not placed under the new token', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    publishFromOtherMachine(fixture, 'claude/remote.md', '# remote\n');
    // A previous holder's delayed autosave during edit's fast-forward (a
    // post-merge hook stands in for it).
    const hook = path.join(fixture.memory, '.git', 'hooks', 'post-merge');
    writeFileSync(hook, '#!/bin/sh\nprintf "# delayed\\n" > "$(git rev-parse --show-toplevel)/claude/delayed.md"\nexit 0\n', { mode: 0o755 });

    const edit = runScript(fixture, ['edit', '--agent', 'claude', '--holder-pid', String(process.pid)]);
    expect(edit.ok).toBe(false);
    expect(edit.error).toMatch(/appeared while the lease was being taken \(claude\/delayed\.md\)/);
    expect(existsSync(fixture.leaseFile)).toBe(false);
  });

  it('a bootstrap commit that changed after validation is caught before the push and undone', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    // A write that lands between the bootstrap's working-tree validation and
    // its commit (a pre-commit hook stands in for it): a NUL byte in a .md.
    const hook = path.join(fixture.memory, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nroot="$(git rev-parse --show-toplevel)"\nif [ -d "$root/codex" ]; then printf "# codex\\n\\000hidden" > "$root/codex/MEMORY.md"; git add "$root/codex/MEMORY.md"; fi\nexit 0\n', { mode: 0o755 });

    const setup = runScript(fixture, ['setup', '--agent', 'codex']);
    expect(setup.ok).toBe(false);
    expect(setup.error).toMatch(/NUL byte found/);
    expect(setup.error).toMatch(/bootstrap commit was undone/);
    expect(originFile(fixture, 'codex/MEMORY.md')).toBeNull();
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('0');
  });

  it('a stale lease (holder process gone) is reclaimable only explicitly, and reclaiming rotates the token', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    const lease = readLease(fixture);
    writeFileSync(fixture.leaseFile, JSON.stringify({ ...lease, holderPid: exitedPid(), holderStart: 'gone' }));

    const status = expectOk(runScript(fixture, ['status', '--agent', 'claude']));
    expect(status.out).toMatch(/Edit lease: stale \(this harness/);

    const implicit = runScript(fixture, ['edit', '--agent', 'claude', '--holder-pid', String(process.pid)]);
    expect(implicit.ok).toBe(false);
    expect(implicit.error).toMatch(/stale memory edit lease exists/);
    expect(implicit.error).toMatch(/--reclaim-stale/);

    const reclaimed = expectOk(runScript(fixture, ['edit', '--agent', 'claude', '--holder-pid', String(process.pid), '--reclaim-stale']));
    expect(reclaimed.warn).toMatch(/Reclaimed a stale memory edit lease/);
    const fresh = tokenOf(reclaimed);
    expect(fresh).not.toBe(token);

    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- reclaimed\n');
    const oldToken = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]);
    expect(oldToken.ok).toBe(false);
    expect(oldToken.error).toMatch(/not yours/);
    expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', fresh]));
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/reclaimed/);
  });

  it('a stale token authorizes nothing: sync, release and renew refuse it, and the holder re-takes its own lease with the token', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    process.env[LEASE_TTL_VARIABLE] = '0';
    const token = tokenOf(expectOk(runScript(fixture, ['edit', '--agent', 'claude'])));
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- edited under a lease that then expired\n');
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(fixture.leaseFile, JSON.stringify({ ...readLease(fixture), createdAt: longAgo, renewedAt: longAgo }));

    for (const argv of [
      ['sync', '--agent', 'claude', '--lease', token],
      ['release', '--agent', 'claude', '--lease', token],
      ['edit', '--agent', 'claude', '--renew', '--lease', token],
    ]) {
      const run = runScript(fixture, argv);
      expect(run.ok).toBe(false);
      expect(run.error).toMatch(/lease is stale/);
    }
    expect(originFile(fixture, 'claude/MEMORY.md')).not.toMatch(/expired/);

    // Without the token the dirty tree blocks a reclaim (it could be anyone's).
    const anonymous = runScript(fixture, ['edit', '--agent', 'claude', '--reclaim-stale']);
    expect(anonymous.ok).toBe(false);
    expect(anonymous.error).toMatch(/unsynced changes/);

    // With the token the edits are provably the holder's: they are kept.
    const retaken = expectOk(runScript(fixture, ['edit', '--agent', 'claude', '--reclaim-stale', '--lease', token, '--holder-pid', String(process.pid)]));
    expect(retaken.warn).toMatch(/Re-took your own stale memory edit lease/);
    const fresh = tokenOf(retaken);
    expect(fresh).not.toBe(token);
    expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', fresh, '--message', 'claude: after expiry']));
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/expired/);
    expect(existsSync(fixture.leaseFile)).toBe(false);
  });

  it('an edit that arrives while sync publishes is never abandoned: the lease is kept and the next sync publishes it', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- first\n');
    // A background task of the holder writes during the push (a pre-push hook
    // stands in for it: it runs inside `git push`, after staging).
    const hook = path.join(fixture.memory, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\nprintf "# late\\n" > "$(git rev-parse --show-toplevel)/claude/late.md"\nexit 0\n', { mode: 0o755 });

    const first = expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: first']));
    expect(first.warn).toMatch(/Edits arrived under claude\/ meanwhile \(claude\/late\.md\); the lease is kept/);
    expect(existsSync(fixture.leaseFile)).toBe(true);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/first/);
    expect(originFile(fixture, 'claude/late.md')).toBeNull();

    // release also refuses to abandon the late edit.
    const release = runScript(fixture, ['release', '--agent', 'claude', '--lease', token]);
    expect(release.ok).toBe(false);
    expect(release.error).toMatch(/unsynced changes/);

    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const second = expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: late']));
    expect(second.out).toMatch(/Lease released/);
    expect(originFile(fixture, 'claude/late.md')).toMatch(/late/);
    expect(existsSync(fixture.leaseFile)).toBe(false);
  });

  it('a file that enters the commit after validation is caught before the push: the commit is undone and the lease kept', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- valid\n');
    // A holder background write that lands between the working-tree
    // validation and the commit (a pre-commit hook stands in for it).
    const hook = path.join(fixture.memory, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nroot="$(git rev-parse --show-toplevel)"\nprintf "binary" > "$root/claude/sneaky.bin"\ngit add "$root/claude/sneaky.bin"\nexit 0\n', { mode: 0o755 });

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: valid']);
    expect(sync.ok).toBe(false);
    expect(sync.error).toMatch(/Committed memory is Markdown-only: claude\/sneaky\.bin/);
    expect(sync.error).toMatch(/commit was undone/);
    expect(originFile(fixture, 'claude/MEMORY.md')).not.toMatch(/valid/);
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('0');
    expect(git(['status', '--porcelain'], fixture.memory)).toMatch(/sneaky\.bin/);
    expect(existsSync(fixture.leaseFile)).toBe(true);

    // Fix the tree (drop the stray file, disarm the hook) and the same lease publishes.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    rmSync(path.join(fixture.memory, 'claude', 'sneaky.bin'));
    expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: valid']));
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/valid/);
    expect(originFile(fixture, 'claude/sneaky.bin')).toBeNull();
    expect(existsSync(fixture.leaseFile)).toBe(false);
  });

  it('a live holder cannot be dispossessed past the TTL; a TTL-only lease can', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    process.env[LEASE_TTL_VARIABLE] = '0';

    acquire(fixture);
    const lease = readLease(fixture);
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(fixture.leaseFile, JSON.stringify({ ...lease, createdAt: longAgo, renewedAt: longAgo }));
    const blocked = runScript(fixture, ['edit', '--agent', 'claude', '--reclaim-stale']);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/live memory edit lease already exists/);

    // Positive control for the guard: the same lease without a holder pid is TTL-only and stale.
    writeFileSync(fixture.leaseFile, JSON.stringify({ ...lease, holderPid: null, holderStart: null, createdAt: longAgo, renewedAt: longAgo }));
    const status = expectOk(runScript(fixture, ['status', '--agent', 'claude']));
    expect(status.out).toMatch(/Edit lease: stale/);
    expectOk(runScript(fixture, ['edit', '--agent', 'claude', '--reclaim-stale']));
  });

  it('setup under a foreign live lease is read-only: no fast-forward, no bootstrap, baseline untouched', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    const headBefore = git(['rev-parse', 'HEAD'], fixture.memory);
    const leaseBefore = readLease(fixture);

    publishFromOtherMachine(fixture, 'claude/remote.md', '# remote\n');

    const other = expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    expect(other.warn).toMatch(/live memory edit lease exists/);
    expect(other.warn).toMatch(/cannot be created under a live lease/);
    expect(git(['rev-parse', 'HEAD'], fixture.memory)).toBe(headBefore);
    expect(existsSync(path.join(fixture.memory, 'codex'))).toBe(false);
    expect(git(['status', '--porcelain'], fixture.memory)).toBe('');
    expect(readLease(fixture)).toEqual(leaseBefore);

    // The holder's own sync still works (its rebase is the legitimate HEAD move).
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- mine\n');
    const refused = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]);
    expect(refused.ok).toBe(false); // the remote commit is same-harness: renew first
    expectOk(runScript(fixture, ['edit', '--agent', 'claude', '--renew', '--lease', token]));
    expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]));

    // Once the lease clears, the deferred bootstrap happens.
    const later = expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    expect(later.out).toMatch(/created and published/);
    expect(originFile(fixture, 'codex/MEMORY.md')).toMatch(/codex memory/);
  });

  it('a session-start setup with a live lease of the same harness also leaves HEAD alone', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    acquire(fixture);
    const headBefore = git(['rev-parse', 'HEAD'], fixture.memory);
    publishFromOtherMachine(fixture, 'claude/remote.md', '# remote\n');

    const again = expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    expect(again.warn).toMatch(/no fast-forward/);
    expect(git(['rev-parse', 'HEAD'], fixture.memory)).toBe(headBefore);
  });
});
