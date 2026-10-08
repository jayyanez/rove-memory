/**
 * Regression tests for the defects the first review of the public repository
 * found: a plaintext remote taken for the configured one, credentials shown in
 * a refusal, an inherited autostash rewriting another session's edits, a
 * process that renames itself losing its lease, and a completed publish
 * reported as a failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import {
  normalizeRemote,
  parseProcStatStartTime,
  probeProcess,
  redactRemote,
} from '../rove-memory.mjs';
import {
  acquire,
  createFixture,
  expectOk,
  git,
  originFile,
  publishFromOtherMachine,
  runScript,
  useLeaseFixtures,
} from './fixture.mjs';

useLeaseFixtures();

function writeHook(fixture, name, body) {
  writeFileSync(path.join(fixture.memory, '.git', 'hooks', name), `#!/bin/sh\n${body}`, { mode: 0o755 });
}

describe('transport and diagnostics', () => {
  it('never takes a plaintext http remote for the https one', () => {
    expect(normalizeRemote('http://github.com/owner/memory.git')).not.toBe(normalizeRemote('https://github.com/owner/memory.git'));
    expect(normalizeRemote('HTTP://example.com/owner/memory')).not.toBe(normalizeRemote('https://example.com/owner/memory'));
    expect(normalizeRemote('HTTPS://GitHub.com/owner/memory')).toBe(normalizeRemote('https://github.com/owner/memory.git'));
  });

  it('masks user information, a query and a fragment when it shows a remote', () => {
    expect(redactRemote('https://user:secret@example.com/o/m.git')).toBe('https://***@example.com/o/m.git');
    expect(redactRemote('https://example.com/o/m.git?access_token=secret')).toBe('https://example.com/o/m.git?***');
    expect(redactRemote('https://example.com/o/m.git#secret')).toBe('https://example.com/o/m.git?***');
    expect(redactRemote('git@github.com:o/m.git')).toBe('git@github.com:o/m.git');
  });

  it('a refusal never prints a credential carried by the checkout\'s own remote', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    git(['config', 'remote.origin.pushurl', 'https://example.com/o/m.git?access_token=TOPSECRET'], fixture.memory);

    const status = runScript(fixture, ['status', '--agent', 'claude']);
    expect(status.ok).toBe(false);
    expect(status.error).toMatch(/Refusing unexpected memory remote/);
    expect(status.error).not.toMatch(/TOPSECRET/);
  });
});

describe('another session\'s working tree', () => {
  it('an inherited rebase.autoStash never stashes or rewrites a foreign edit: the rebase refuses instead', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    git(['config', 'rebase.autoStash', 'true'], fixture.memory);
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- mine\n');
    // Upstream changes codex's index, so sync must rebase...
    publishFromOtherMachine(fixture, 'codex/MEMORY.md', '# codex\n\n- upstream\n', 'codex: upstream');
    // ...and while sync fetches, a codex session edits the same file.
    const foreign = '# codex\n\n- being written by another session\n';
    const foreignFile = path.join(fixture.memory, 'codex', 'MEMORY.md');
    writeHook(fixture, 'reference-transaction', [
      '[ "$1" = committed ] || exit 0',
      'grep -q refs/remotes/origin/main || exit 0',
      'gitdir="$(git rev-parse --absolute-git-dir)"',
      'root="$(git rev-parse --show-toplevel)"',
      '[ -e "$gitdir/foreign" ] && exit 0',
      ': > "$gitdir/foreign"',
      'printf "# codex\\n\\n- being written by another session\\n" > "$root/codex/MEMORY.md"',
      'exit 0',
      '',
    ].join('\n'));

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: mine']);
    expect(readFileSync(foreignFile, 'utf8').replace(/\r\n/g, '\n')).toBe(foreign);
    expect(git(['stash', 'list'], fixture.memory)).toBe('');
    expect(sync.ok).toBe(false);
    expect(originFile(fixture, 'claude/MEMORY.md')).not.toMatch(/mine/);
  });
});

describe('lease holder identity', () => {
  it('a holder that renames itself is still the same process', () => {
    const before = probeProcess(process.pid, { fresh: true });
    const title = process.title;
    try {
      process.title = 'rove-memory-renamed-holder';
      const after = probeProcess(process.pid, { fresh: true });
      expect(before.state).toBe('alive');
      expect(after.start).toBe(before.start);
    } finally {
      process.title = title;
    }
  });

  it('reads the start time from a /proc stat line whose command name holds spaces and parentheses', () => {
    const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
    fields[0] = 'S';
    expect(parseProcStatStartTime(`4242 (node (a) b) ${fields.join(' ')}`)).toBe('22');
    expect(parseProcStatStartTime('garbage')).toBeNull();
    expect(parseProcStatStartTime('1 (x) S 2')).toBeNull();
  });
});

describe('after a publish', () => {
  it('a late, invalid edit does not turn a completed publish into a failure: the lease is kept for it', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- published\n');
    // A write lands during the push (a pre-push hook stands in for it).
    writeHook(fixture, 'pre-push', 'printf "binary" > "$(git rev-parse --show-toplevel)/claude/late.bin"\nexit 0\n');

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: published']);
    expect(sync.error).toBe('');
    expect(sync.warn).toMatch(/Published claude memory \(1 files, .*the lease is kept/);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/published/);
  });
});
