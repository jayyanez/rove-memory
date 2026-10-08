/**
 * Regression tests for the defects the first review of the tool found in the
 * design it inherited (remote checks, credentials in remotes, commits that
 * land between validation and push, a bootstrap whose push failed).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import {
  isAgentOwnedPath,
  normalizeRemote,
  parseProjectConfig,
  validateOwnedPendingPaths,
} from '../rove-memory.mjs';
import {
  acquire,
  createFixture,
  expectOk,
  git,
  originFile,
  publishFromOtherMachine,
  runScript,
  temporaryDirectory,
  useLeaseFixtures,
} from './fixture.mjs';

useLeaseFixtures();

/** A path a POSIX shell inside a Git hook can use. */
function shellPath(value) {
  return value.replaceAll('\\', '/');
}

function writeHook(fixture, name, body) {
  writeFileSync(path.join(fixture.memory, '.git', 'hooks', name), `#!/bin/sh\n${body}`, { mode: 0o755 });
}

function bareRepository() {
  const directory = path.join(temporaryDirectory('rove-memory-elsewhere-'), 'elsewhere.git');
  git(['init', '--bare', '--initial-branch=main', directory], path.dirname(directory));
  return directory;
}

function hasMain(repository) {
  try {
    git(['rev-parse', '--verify', 'main'], repository);
    return true;
  } catch {
    return false;
  }
}

describe('remote identity', () => {
  it('compares hosts without case but keeps the repository path case', () => {
    expect(normalizeRemote('https://github.com/Owner/Memory.git')).not.toBe(normalizeRemote('https://github.com/owner/memory.git'));
    expect(normalizeRemote('https://GitHub.com/owner/memory.git')).toBe(normalizeRemote('git@github.com:owner/memory.git'));
    expect(normalizeRemote('ssh://git@GITHUB.com/owner/memory')).toBe('github.com/owner/memory');
  });

  it('keeps an SSH account other than git: two accounts are two repositories', () => {
    expect(normalizeRemote('alice@host.example:memory.git')).not.toBe(normalizeRemote('bob@host.example:memory.git'));
    expect(normalizeRemote('ssh://alice@host.example/memory')).not.toBe(normalizeRemote('ssh://bob@host.example/memory'));
    expect(normalizeRemote('alice@host.example:memory')).not.toBe(normalizeRemote('https://host.example/memory'));
    expect(normalizeRemote('Alice@host.example:memory')).not.toBe(normalizeRemote('alice@host.example:memory'));
    expect(normalizeRemote('alice@HOST.example:memory')).toBe(normalizeRemote('ssh://alice@host.example/memory'));
    expect(normalizeRemote('git@github.com:owner/memory.git')).toBe(normalizeRemote('https://github.com/owner/memory.git'));
  });

  it('treats HTTPS and SSH as one repository only on github.com', () => {
    expect(normalizeRemote('https://gitlab.example/owner/memory.git')).not.toBe(normalizeRemote('git@gitlab.example:owner/memory.git'));
    expect(normalizeRemote('https://gitlab.example/owner/memory.git')).not.toBe(normalizeRemote('ssh://git@gitlab.example/owner/memory.git'));
    expect(normalizeRemote('git@gitlab.example:owner/memory.git')).toBe(normalizeRemote('ssh://git@GITLAB.example/owner/memory'));
    expect(normalizeRemote('https://token@github.com/owner/memory.git')).not.toBe(normalizeRemote('https://github.com/owner/memory.git'));
    expect(normalizeRemote('ssh://alice@github.com/owner/memory.git')).not.toBe(normalizeRemote('https://github.com/owner/memory.git'));
  });

  it('refuses any remote that could carry a credential', () => {
    for (const remote of [
      'ssh://git:secret@github.com/owner/memory.git',
      'ssh://git%3Asecret@github.com/owner/memory.git',
      'https://github.com/owner/memory.git?access_token=secret',
      'https://github.com/owner/memory.git#secret',
      'https://github.com:secret@evil.example/owner/memory.git',
      'git:secret@github.com:owner/memory.git',
    ]) {
      expect(() => parseProjectConfig(JSON.stringify({ roveMemory: { project: 'X', remote } }))).toThrow(/"roveMemory\.remote"/);
    }
  });

  it('refuses a checkout that would push anywhere but the configured remote', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const elsewhere = bareRepository();

    // Positive control: a push URL that IS the configured remote is fine.
    git(['config', 'remote.origin.pushurl', fixture.origin], fixture.memory);
    expectOk(runScript(fixture, ['status', '--agent', 'claude']));

    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- private\n');
    for (const redirect of [
      () => git(['config', 'remote.origin.pushurl', elsewhere], fixture.memory),
      () => git(['config', '--add', 'remote.origin.url', elsewhere], fixture.memory),
      () => git(['config', `url.${elsewhere}.pushInsteadOf`, fixture.origin], fixture.memory),
    ]) {
      redirect();
      const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]);
      expect(sync.ok).toBe(false);
      expect(sync.error).toMatch(/Refusing unexpected memory remote/);
      const status = runScript(fixture, ['status', '--agent', 'claude']);
      expect(status.ok).toBe(false);
      // Undo whichever redirect this round added (the others are absent).
      for (const undo of [
        ['config', '--unset-all', 'remote.origin.pushurl'],
        ['config', '--replace-all', 'remote.origin.url', fixture.origin],
        ['config', '--remove-section', `url.${elsewhere}`],
      ]) {
        try {
          git(undo, fixture.memory);
        } catch {
          // Not set in this round.
        }
      }
    }
    expect(hasMain(elsewhere)).toBe(false);
    expect(originFile(fixture, 'claude/MEMORY.md')).not.toMatch(/private/);
  });
});

describe('ownership of paths', () => {
  it('treats a backslash as part of a file name, never as a separator', () => {
    expect(isAgentOwnedPath('codex\\x.md', 'codex')).toBe(false);
    expect(isAgentOwnedPath('codex/x.md', 'codex')).toBe(true);
    expect(() => validateOwnedPendingPaths(['codex\\x.md'], 'codex')).toThrow(/another owner's local commit/);
  });
});

describe('only the caller\'s own commit is published', () => {
  it('sync refuses a same-harness commit that lands before its rebase instead of rebasing and pushing it', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- mine\n');
    // Another harness advances origin, so sync must rebase.
    publishFromOtherMachine(fixture, 'codex/MEMORY.md', '# codex\n', 'codex: update');
    // When sync's fetch moves origin/main, a session that ignored the lease
    // commits a NUL byte under claude/ on top of the holder's commit.
    writeHook(fixture, 'reference-transaction', [
      '[ "$1" = committed ] || exit 0',
      'grep -q refs/remotes/origin/main || exit 0',
      'gitdir="$(git rev-parse --absolute-git-dir)"',
      'root="$(git rev-parse --show-toplevel)"',
      '[ -e "$gitdir/concurrent" ] && exit 0',
      ': > "$gitdir/concurrent"',
      'printf "# concurrent\\n\\000hidden" > "$root/claude/concurrent.md"',
      'git add "$root/claude/concurrent.md"',
      'git -c user.name=x -c user.email=x@y commit -q -m concurrent -- "$root/claude/concurrent.md"',
      'exit 0',
      '',
    ].join('\n'));

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: mine']);
    expect(originFile(fixture, 'claude/concurrent.md')).toBeNull();
    expect(sync.ok).toBe(false);
    expect(sync.error).toMatch(/not yours became HEAD of the shared memory checkout before the rebase/);
    expect(originFile(fixture, 'claude/MEMORY.md')).not.toMatch(/mine/);
  });

  it('a bootstrap publishes only its own commit, never one that lands while it publishes', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    publishFromOtherMachine(fixture, 'codex/one.md', '# one\n', 'codex: one');
    // setup's pull moves origin/main first: the hook then advances origin
    // again from the other machine, so the bootstrap's own fetch moves it
    // too, and at that moment a raw commit lands on top of the bootstrap.
    const other = shellPath(fixture.otherMachine);
    writeHook(fixture, 'reference-transaction', [
      '[ "$1" = committed ] || exit 0',
      'grep -q refs/remotes/origin/main || exit 0',
      'gitdir="$(git rev-parse --absolute-git-dir)"',
      'root="$(git rev-parse --show-toplevel)"',
      'if [ ! -e "$gitdir/advanced" ]; then',
      '  : > "$gitdir/advanced"',
      `  ( unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX; cd "${other}" && git pull -q --ff-only origin main && printf "# two\\n" > codex/two.md && git add codex/two.md && git -c user.name=x -c user.email=x@y commit -q -m two && git push -q origin HEAD:main )`,
      '  exit 0',
      'fi',
      '[ -f "$root/claude/MEMORY.md" ] || exit 0',
      '[ -e "$gitdir/concurrent" ] && exit 0',
      ': > "$gitdir/concurrent"',
      'printf "# concurrent\\n\\000hidden" > "$root/claude/concurrent.md"',
      'git add "$root/claude/concurrent.md"',
      'git -c user.name=x -c user.email=x@y commit -q -m concurrent -- "$root/claude/concurrent.md"',
      'exit 0',
      '',
    ].join('\n'));

    const setup = runScript(fixture, ['setup', '--agent', 'claude']);
    expect(existsSync(path.join(fixture.memory, '.git', 'concurrent'))).toBe(true);
    expect(originFile(fixture, 'claude/concurrent.md')).toBeNull();
    expect(setup.ok).toBe(false);
    expect(setup.error).toMatch(/not yours became HEAD of the shared memory checkout before the rebase/);
    expect(originFile(fixture, 'claude/MEMORY.md')).toBeNull();
  });

  it('setup publishes a bootstrap whose first push failed, so edit can start', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    const block = path.join(fixture.memory, '.git', 'block-push');
    writeFileSync(block, '');
    writeHook(fixture, 'pre-push', `[ -e "$(git rev-parse --absolute-git-dir)/block-push" ] && exit 1\nexit 0\n`);

    const failed = runScript(fixture, ['setup', '--agent', 'claude']);
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/Memory push failed after 3 attempts/);
    expect(originFile(fixture, 'claude/MEMORY.md')).toBeNull();

    rmSync(block);
    const retried = expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    expect(retried.out).toMatch(/published its earlier unpublished commits/);
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/claude memory for Fixture/);
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('0');
    acquire(fixture);
  });

  // A commit that lands right after the caller's own (a post-commit hook
  // stands in for a session that bypassed the lease) must not be taken for it.
  const commitOnTop = [
    'gitdir="$(git rev-parse --absolute-git-dir)"',
    'root="$(git rev-parse --show-toplevel)"',
    '[ -e "$gitdir/on-top" ] && exit 0',
    ': > "$gitdir/on-top"',
    'printf "# on top\\n" > "$root/claude/on-top.md"',
    'git add "$root/claude/on-top.md"',
    'git -c user.name=x -c user.email=x@y commit -q -m on-top -- "$root/claude/on-top.md"',
    'exit 0',
    '',
  ].join('\n');

  it('a bootstrap never adopts a commit that lands right after its own', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    writeHook(fixture, 'post-commit', commitOnTop);

    const setup = runScript(fixture, ['setup', '--agent', 'claude']);
    expect(originFile(fixture, 'claude/on-top.md')).toBeNull();
    expect(setup.ok).toBe(false);
    expect(setup.error).toMatch(/moved while your commit was being made/);
  });

  it('sync never adopts a commit that lands right after the holder\'s own', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- mine\n');
    writeHook(fixture, 'post-commit', commitOnTop);

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: mine']);
    expect(originFile(fixture, 'claude/on-top.md')).toBeNull();
    expect(sync.ok).toBe(false);
    expect(sync.error).toMatch(/moved while your commit was being made/);
  });

  // A commit that lands once the caller's files are staged, before its own
  // commit is made (a post-index-change hook builds it with plumbing, without
  // touching the real index), must not become the parent it publishes with.
  const commitBeforeOwn = [
    'git diff --cached --quiet -- claude && exit 0',
    'gitdir="$(git rev-parse --absolute-git-dir)"',
    '[ -e "$gitdir/early" ] && exit 0',
    ': > "$gitdir/early"',
    'export GIT_INDEX_FILE="$gitdir/early-index"',
    'git read-tree HEAD',
    'blob=$(printf "# early\\n" | git hash-object -w --stdin)',
    'git update-index --add --cacheinfo "100644,$blob,claude/early.md"',
    'tree=$(git write-tree)',
    'commit=$(git -c user.name=x -c user.email=x@y commit-tree "$tree" -p HEAD -m early)',
    'git update-ref HEAD "$commit"',
    'exit 0',
    '',
  ].join('\n');

  function originHistory(fixture) {
    return git(['log', '--format=%s', 'main'], fixture.origin);
  }

  it('a bootstrap never publishes on top of a commit that landed before its own', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    writeHook(fixture, 'post-index-change', commitBeforeOwn);

    const setup = runScript(fixture, ['setup', '--agent', 'claude']);
    expect(existsSync(path.join(fixture.memory, '.git', 'early'))).toBe(true);
    expect(originHistory(fixture)).not.toMatch(/early/);
    expect(setup.ok).toBe(false);
    expect(setup.error).toMatch(/moved while your commit was being made/);
  });

  it('sync never publishes on top of a commit that landed after its generation check', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- mine\n');
    writeHook(fixture, 'post-index-change', commitBeforeOwn);

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: mine']);
    expect(existsSync(path.join(fixture.memory, '.git', 'early'))).toBe(true);
    expect(originHistory(fixture)).not.toMatch(/early/);
    expect(sync.ok).toBe(false);
    expect(sync.error).toMatch(/moved while your commit was being made/);
  });

  it('a bootstrap publish never rebases over a folder another machine published; edit and sync take the commits over', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    // The bootstrap's push fails, and a second commit of claude's waits too.
    const block = path.join(fixture.memory, '.git', 'block-push');
    writeFileSync(block, '');
    writeHook(fixture, 'pre-push', `[ -e "$(git rev-parse --absolute-git-dir)/block-push" ] && exit 1\nexit 0\n`);
    expect(runScript(fixture, ['setup', '--agent', 'claude']).ok).toBe(false);
    writeFileSync(path.join(fixture.memory, 'claude', 'second.md'), '# second\n');
    git(['add', '--', 'claude/second.md'], fixture.memory);
    git(['commit', '-q', '-m', 'claude: second', '--', 'claude/second.md'], fixture.memory);
    // Another machine published the very same bootstrap; a rebase here would
    // drop claude's first commit, and a commit landing during it could claim
    // that change.
    publishFromOtherMachine(fixture, 'claude/MEMORY.md', '# claude memory for Fixture\n\nNo durable entries yet.\n', 'claude: same bootstrap');
    rmSync(block);
    writeHook(fixture, 'post-rewrite', commitOnTop);

    const setup = runScript(fixture, ['setup', '--agent', 'claude']);
    expect(setup.ok).toBe(false);
    expect(setup.error).toMatch(/Another machine already published claude\/ to origin\/main; nothing was pushed and your local commits are kept/);
    expect(existsSync(path.join(fixture.memory, '.git', 'on-top'))).toBe(false);
    expect(originFile(fixture, 'claude/second.md')).toBeNull();
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('2');

    // The way forward it names: edit adopts the commits under a lease, sync publishes.
    rmSync(path.join(fixture.memory, '.git', 'hooks', 'post-rewrite'));
    const token = acquire(fixture);
    expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]));
    expect(originFile(fixture, 'claude/second.md')).toBe('# second\n');
    expect(originFile(fixture, 'claude/MEMORY.md')).toMatch(/claude memory for Fixture/);
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('0');
  });

  it('a bootstrap whose push landed but whose acknowledgement was lost is recognised as published', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    const block = path.join(fixture.memory, '.git', 'block-push');
    writeFileSync(block, '');
    writeHook(fixture, 'pre-push', `[ -e "$(git rev-parse --absolute-git-dir)/block-push" ] && exit 1\nexit 0\n`);
    expect(runScript(fixture, ['setup', '--agent', 'claude']).ok).toBe(false);
    rmSync(block);
    // The push reaches origin, but this checkout never learns it did.
    const recorded = git(['rev-parse', 'refs/remotes/origin/main'], fixture.memory);
    git(['push', '-q', 'origin', 'HEAD:main'], fixture.memory);
    git(['update-ref', 'refs/remotes/origin/main', recorded], fixture.memory);

    const setup = expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    expect(setup.out).toMatch(/published its earlier unpublished commits/);
    expect(git(['rev-list', '--count', 'origin/main..HEAD'], fixture.memory)).toBe('0');
  });

  it('a rebase cannot claim one of the caller\'s changes twice', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    // claude's bootstrap push fails; claude then adds a topic and removes it,
    // so its own changes include "add claude/x.md" once.
    const block = path.join(fixture.memory, '.git', 'block-push');
    writeFileSync(block, '');
    writeHook(fixture, 'pre-push', `[ -e "$(git rev-parse --absolute-git-dir)/block-push" ] && exit 1\nexit 0\n`);
    expect(runScript(fixture, ['setup', '--agent', 'claude']).ok).toBe(false);
    writeFileSync(path.join(fixture.memory, 'claude', 'x.md'), '# x\n');
    git(['add', '--', 'claude/x.md'], fixture.memory);
    git(['commit', '-q', '-m', 'claude: add x', '--', 'claude/x.md'], fixture.memory);
    git(['rm', '-q', '--', 'claude/x.md'], fixture.memory);
    git(['commit', '-q', '-m', 'claude: remove x'], fixture.memory);
    publishFromOtherMachine(fixture, 'codex/MEMORY.md', '# codex\n', 'codex: update');
    rmSync(block);
    // While the rebase finishes, a commit with that very change lands again.
    writeHook(fixture, 'post-rewrite', [
      'gitdir="$(git rev-parse --absolute-git-dir)"',
      'root="$(git rev-parse --show-toplevel)"',
      '[ -e "$gitdir/again" ] && exit 0',
      ': > "$gitdir/again"',
      'printf "# x\\n" > "$root/claude/x.md"',
      'git add "$root/claude/x.md"',
      'git -c user.name=x -c user.email=x@y commit -q -m again -- "$root/claude/x.md"',
      'exit 0',
      '',
    ].join('\n'));

    const setup = runScript(fixture, ['setup', '--agent', 'claude']);
    expect(existsSync(path.join(fixture.memory, '.git', 'again'))).toBe(true);
    expect(originFile(fixture, 'claude/x.md')).toBeNull();
    expect(setup.ok).toBe(false);
    expect(setup.error).toMatch(/carried a commit that is not yours/);
  });

  it('a change that is already upstream is never rebased away for another commit to claim', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    // A topic with two identical blocks: changing "d" in either block gives
    // the same patch id, because a patch id ignores line numbers.
    const block = 'a\nb\nc\nd\ne\nf\ng\n';
    const filler = Array.from({ length: 8 }, (_, line) => `filler ${line}\n`).join('');
    const topic = `${block}${filler}${block}`;
    const changedFirst = `${block.replace('d\n', 'D\n')}${filler}${block}`;
    const bootstrap = '# claude memory for Fixture\n\nNo durable entries yet.\n';
    // claude's bootstrap push fails; three more commits wait behind it.
    const blocked = path.join(fixture.memory, '.git', 'block-push');
    writeFileSync(blocked, '');
    writeHook(fixture, 'pre-push', `[ -e "$(git rev-parse --absolute-git-dir)/block-push" ] && exit 1\nexit 0\n`);
    expect(runScript(fixture, ['setup', '--agent', 'claude']).ok).toBe(false);
    const commitFile = (relative, contents, subject) => {
      writeFileSync(path.join(fixture.memory, relative), contents);
      git(['add', '--', relative], fixture.memory);
      git(['commit', '-q', '-m', subject, '--', relative], fixture.memory);
    };
    commitFile('claude/topic.md', topic, 'claude: topic');
    commitFile('claude/topic.md', changedFirst, 'claude: change the first block');
    commitFile('claude/other.md', '# other\n', 'claude: other');
    // Another machine already published the bootstrap, and the topic with
    // its change inside one larger commit, so a rebase would drop all three
    // as empty and replay only "other".
    publishFromOtherMachine(fixture, 'claude/MEMORY.md', bootstrap, 'same bootstrap');
    publishFromOtherMachine(fixture, 'codex/notes.md', '# notes\n', 'unrelated');
    git(['pull', '-q', '--ff-only', 'origin', 'main'], fixture.otherMachine);
    writeFileSync(path.join(fixture.otherMachine, 'claude', 'topic.md'), changedFirst);
    writeFileSync(path.join(fixture.otherMachine, 'codex', 'notes.md'), '# notes, edited\n');
    git(['add', '--all'], fixture.otherMachine);
    git(['commit', '-q', '-m', 'topic and notes'], fixture.otherMachine);
    git(['push', '-q', 'origin', 'HEAD:main'], fixture.otherMachine);
    rmSync(blocked);
    // While the rebase finishes, a commit changes the SECOND block the same way.
    const changedBoth = `${block.replace('d\n', 'D\n')}${filler}${block.replace('d\n', 'D\n')}`;
    const again = path.join(temporaryDirectory('rove-memory-again-'), 'topic.md');
    writeFileSync(again, changedBoth);
    writeHook(fixture, 'post-rewrite', [
      'gitdir="$(git rev-parse --absolute-git-dir)"',
      'root="$(git rev-parse --show-toplevel)"',
      '[ -e "$gitdir/second-block" ] && exit 0',
      ': > "$gitdir/second-block"',
      `cp "${shellPath(again)}" "$root/claude/topic.md"`,
      'git add "$root/claude/topic.md"',
      'git -c user.name=x -c user.email=x@y commit -q -m second-block -- "$root/claude/topic.md"',
      'exit 0',
      '',
    ].join('\n'));

    const setup = runScript(fixture, ['setup', '--agent', 'claude']);
    expect(originFile(fixture, 'claude/topic.md')).toBe(changedFirst);
    expect(existsSync(path.join(fixture.memory, '.git', 'second-block'))).toBe(false);
    expect(setup.ok).toBe(false);
    expect(setup.error).toMatch(/Another machine already published claude\//);
  });

  it('a holder\'s change that upstream made and then reverted is still published', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const topic = '# topic\n\n- d\n';
    const changed = '# topic\n\n- D\n';
    let token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'topic.md'), topic);
    expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: topic']));

    token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'topic.md'), changed);
    // Upstream, another machine made the very same change and reverted it:
    // the folder upstream is back at the lease baseline, so sync goes on,
    // and a rebase that skips "already upstream" changes would drop the
    // holder's commit while reporting it published.
    publishFromOtherMachine(fixture, 'claude/topic.md', changed, 'same change');
    publishFromOtherMachine(fixture, 'claude/topic.md', topic, 'revert it');
    publishFromOtherMachine(fixture, 'codex/MEMORY.md', '# codex\n', 'codex: update');

    expectOk(runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: D']));
    expect(originFile(fixture, 'claude/topic.md')).toBe(changed);
    expect(git(['log', '-1', '--format=%s', 'main'], fixture.origin)).toBe('claude: D');
  });

  it('empty commits never wait to be published: a rebase could drop them and let others take their place', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'codex']));
    const block = path.join(fixture.memory, '.git', 'block-push');
    writeFileSync(block, '');
    writeHook(fixture, 'pre-push', `[ -e "$(git rev-parse --absolute-git-dir)/block-push" ] && exit 1\nexit 0\n`);
    expect(runScript(fixture, ['setup', '--agent', 'claude']).ok).toBe(false);
    git(['commit', '-q', '--allow-empty', '-m', 'claude: empty one'], fixture.memory);
    git(['commit', '-q', '--allow-empty', '-m', 'claude: empty two'], fixture.memory);
    publishFromOtherMachine(fixture, 'codex/MEMORY.md', '# codex\n', 'codex: update');
    rmSync(block);
    // While the rebase finishes, a change and its restore land in their place.
    writeHook(fixture, 'post-rewrite', [
      'gitdir="$(git rev-parse --absolute-git-dir)"',
      'root="$(git rev-parse --show-toplevel)"',
      '[ -e "$gitdir/pair" ] && exit 0',
      ': > "$gitdir/pair"',
      'printf "# pair\\n" > "$root/claude/pair.md"',
      'git add "$root/claude/pair.md"',
      'git -c user.name=x -c user.email=x@y commit -q -m pair-change -- "$root/claude/pair.md"',
      'git rm -q "$root/claude/pair.md"',
      'git -c user.name=x -c user.email=x@y commit -q -m pair-restore',
      'exit 0',
      '',
    ].join('\n'));

    const setup = runScript(fixture, ['setup', '--agent', 'claude']);
    expect(git(['log', '--format=%s', 'main'], fixture.origin)).not.toMatch(/pair-/);
    expect(setup.ok).toBe(false);
    expect(setup.error).toMatch(/Refusing to publish empty commit/);
  });

  it('a merge never waits to be published: memory history is linear', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    // A merge of two of claude's own commits, made by hand in the checkout.
    const base = git(['rev-parse', 'HEAD'], fixture.memory);
    writeFileSync(path.join(fixture.memory, 'claude', 'left.md'), '# left\n');
    git(['add', '--', 'claude/left.md'], fixture.memory);
    git(['commit', '-q', '-m', 'left', '--', 'claude/left.md'], fixture.memory);
    const left = git(['rev-parse', 'HEAD'], fixture.memory);
    git(['reset', '-q', '--hard', base], fixture.memory);
    writeFileSync(path.join(fixture.memory, 'claude', 'right.md'), '# right\n');
    git(['add', '--', 'claude/right.md'], fixture.memory);
    git(['commit', '-q', '-m', 'right', '--', 'claude/right.md'], fixture.memory);
    git(['merge', '-q', '--no-ff', '-m', 'merge', left], fixture.memory);
    writeFileSync(fixture.leaseFile, JSON.stringify({ ...JSON.parse(readFileSync(fixture.leaseFile, 'utf8')), commit: git(['rev-parse', 'HEAD'], fixture.memory) }));

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token]);
    expect(sync.ok).toBe(false);
    expect(sync.error).toMatch(/Memory history must be linear/);
    expect(originFile(fixture, 'claude/left.md')).toBeNull();
  });

  it('sync refuses a rebase that carries a merge commit', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- mine\n');
    publishFromOtherMachine(fixture, 'codex/MEMORY.md', '# codex\n', 'codex: update');
    // While the rebase finishes, a merge of origin/main lands on top that
    // brings a file of its own (built with plumbing, the index untouched).
    writeHook(fixture, 'post-rewrite', [
      'gitdir="$(git rev-parse --absolute-git-dir)"',
      '[ -e "$gitdir/merged" ] && exit 0',
      ': > "$gitdir/merged"',
      'export GIT_INDEX_FILE="$gitdir/merge-index"',
      'git read-tree HEAD',
      'blob=$(printf "# merged\\n" | git hash-object -w --stdin)',
      'git update-index --add --cacheinfo "100644,$blob,claude/merged.md"',
      'tree=$(git write-tree)',
      'commit=$(git -c user.name=x -c user.email=x@y commit-tree "$tree" -p HEAD -p origin/main -m merged)',
      'git update-ref HEAD "$commit"',
      'exit 0',
      '',
    ].join('\n'));

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: mine']);
    expect(existsSync(path.join(fixture.memory, '.git', 'merged'))).toBe(true);
    expect(originFile(fixture, 'claude/merged.md')).toBeNull();
    expect(sync.ok).toBe(false);
    expect(sync.error).toMatch(/Memory history must be linear/);
  });

  it('a large update within the bounds publishes through a rebase', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    // Six topics of about 200 KiB: within the 256 KiB topic and 2 MiB folder
    // bounds, and a patch well over spawnSync's 1 MiB default buffer.
    const line = `${'word '.repeat(19)}word\n`;
    for (let topic = 1; topic <= 6; topic += 1) {
      writeFileSync(path.join(fixture.memory, 'claude', `topic-${topic}.md`), `# topic ${topic}\n\n${line.repeat(2000)}`);
    }
    publishFromOtherMachine(fixture, 'codex/MEMORY.md', '# codex\n', 'codex: update');

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: six topics']);
    expect(sync.error).toBe('');
    expect(originFile(fixture, 'claude/topic-6.md')).toMatch(/^# topic 6\n/);
  });

  it('sync refuses a rebase that carries a commit beyond the holder\'s own', () => {
    const fixture = createFixture();
    expectOk(runScript(fixture, ['setup', '--agent', 'claude']));
    const token = acquire(fixture);
    writeFileSync(path.join(fixture.memory, 'claude', 'MEMORY.md'), '# claude\n\n- mine\n');
    publishFromOtherMachine(fixture, 'codex/MEMORY.md', '# codex\n', 'codex: update');
    // A valid Markdown commit lands while the rebase finishes.
    writeHook(fixture, 'post-rewrite', commitOnTop);

    const sync = runScript(fixture, ['sync', '--agent', 'claude', '--lease', token, '--message', 'claude: mine']);
    expect(existsSync(path.join(fixture.memory, '.git', 'on-top'))).toBe(true);
    expect(originFile(fixture, 'claude/on-top.md')).toBeNull();
    expect(sync.ok).toBe(false);
    expect(sync.error).toMatch(/not yours/);
  });
});
