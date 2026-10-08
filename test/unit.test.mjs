import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { expect } from './expect.mjs';
import {
  acquireMemoryLock,
  countTextLines,
  hasMemoryToPublish,
  INDEX_MAX_BYTES,
  isAgentOwnedPath,
  mergeClaudeSettings,
  normalizeRemote,
  parsePendingCommitPathOutput,
  parsePorcelainZ,
  rebaseOntoOrigin,
  validateAgentId,
  validateMemoryBranch,
  validateMemoryTree,
  validateOwnedPendingPaths,
} from '../rove-memory.mjs';

const temporaryDirectories = [];

function memoryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 'rove-memory-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('agent memory identity', () => {
  it('accepts stable lowercase harness ids', () => {
    expect(validateAgentId('codex')).toBe('codex');
    expect(validateAgentId('grok-reviewer')).toBe('grok-reviewer');
    expect(validateAgentId('agent2')).toBe('agent2');
  });

  for (const value of ['Claude', '../codex', 'codex/session', '-agent', 'agent_name', '']) {
    it(`rejects unsafe or unstable id ${JSON.stringify(value)}`, () => {
      expect(() => validateAgentId(value)).toThrow(/Agent id/);
    });
  }
});

describe('memory repository safety', () => {
  it('normalizes HTTPS and SSH forms of the private remote', () => {
    expect(normalizeRemote('https://github.com/example-owner/project-agent-memory.git')).toBe(
      'github.com/example-owner/project-agent-memory',
    );
    expect(normalizeRemote('git@github.com:example-owner/project-agent-memory.git')).toBe(
      'github.com/example-owner/project-agent-memory',
    );
    expect(normalizeRemote('ssh://git@github.com/example-owner/project-agent-memory')).toBe(
      'github.com/example-owner/project-agent-memory',
    );
  });

  it('recognizes only paths inside the exact harness folder', () => {
    expect(isAgentOwnedPath('codex/MEMORY.md', 'codex')).toBe(true);
    expect(isAgentOwnedPath('codex/topics/windows.md', 'codex')).toBe(true);
    expect(isAgentOwnedPath('claude/MEMORY.md', 'codex')).toBe(false);
    expect(isAgentOwnedPath('codex-other/MEMORY.md', 'codex')).toBe(false);
    expect(isAgentOwnedPath('README.md', 'codex')).toBe(false);
  });

  it('preserves both sides of a rename in porcelain output', () => {
    const entries = parsePorcelainZ('R  codex/new.md\0codex/old.md\0?? claude/new.md\0');
    expect(entries).toEqual([
      { status: 'R ', path: 'codex/new.md' },
      { status: 'R ', path: 'codex/old.md' },
      { status: '??', path: 'claude/new.md' },
    ]);
  });

  it('keeps publishing work visible after the working tree becomes clean', () => {
    expect(hasMemoryToPublish([], 1)).toBe(true);
    expect(hasMemoryToPublish([], 0)).toBe(false);
    expect(hasMemoryToPublish([{ status: ' M', path: 'codex/MEMORY.md' }], 0)).toBe(true);
  });

  it('keeps every path touched by unpublished commits, including reverted paths', () => {
    expect(
      parsePendingCommitPathOutput(
        'claude/MEMORY.md\0claude/MEMORY.md\0codex/MEMORY.md\0',
      ),
    ).toEqual(['claude/MEMORY.md', 'codex/MEMORY.md']);
  });

  it('aborts a conflicting rebase before surfacing the failure', () => {
    const calls = [];
    const runGit = (args) => {
      calls.push(args);
      if (args[1] === '--abort') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'CONFLICT in codex/MEMORY.md' };
    };

    expect(() => rebaseOntoOrigin('memory-root', runGit)).toThrow(
      /rebase was aborted cleanly/,
    );
    expect(calls).toEqual([
      ['rebase', 'origin/main'],
      ['rebase', '--abort'],
    ]);
  });

  it('refuses unpublished commits outside the active harness folder', () => {
    expect(() => validateOwnedPendingPaths(['claude/MEMORY.md'], 'codex')).toThrow(
      /another owner's local commit/,
    );
    expect(() => validateOwnedPendingPaths(['codex/MEMORY.md'], 'codex')).not.toThrow();
  });

  it('removes a lock file when initialization fails after exclusive creation', () => {
    const cleanup = [];
    const lockIo = {
      openSync: () => 42,
      writeFileSync: () => {
        throw new Error('disk full');
      },
      closeSync: () => cleanup.push('closed'),
      unlinkSync: () => cleanup.push('removed'),
      existsSync: () => false,
      readFileSync: () => '',
    };

    expect(() => acquireMemoryLock('git-directory', 'codex', 'sync', lockIo)).toThrow(
      /incomplete lock was removed/,
    );
    expect(cleanup).toEqual(['closed', 'removed']);
  });

  it('reports recorded ownership when a memory lock already exists', () => {
    const lockIo = {
      openSync: () => {
        throw new Error('EEXIST');
      },
      writeFileSync: () => undefined,
      closeSync: () => undefined,
      unlinkSync: () => undefined,
      existsSync: () => true,
      readFileSync: () => JSON.stringify({
        agent: 'claude',
        operation: 'setup',
        pid: 1234,
        startedAt: '2026-08-24T00:00:00.000Z',
      }),
    };

    expect(() => acquireMemoryLock('git-directory', 'codex', 'sync', lockIo)).toThrow(
      /agent=claude, operation=setup, pid=1234, startedAt=2026-08-24T00:00:00.000Z/,
    );
  });

  it('requires the shared memory checkout to stay on main', () => {
    expect(() => validateMemoryBranch('main')).not.toThrow();
    expect(() => validateMemoryBranch('experiment')).toThrow(/must stay on main/);
    expect(() => validateMemoryBranch('')).toThrow(/detached/);
  });
});

describe('Claude configuration', () => {
  it('adds the absolute memory directory without dropping existing settings', () => {
    const directory = memoryDirectory();
    const merged = JSON.parse(
      mergeClaudeSettings(
        JSON.stringify({ permissions: { allow: ['Bash(git fetch *)'] } }),
        path.join(directory, 'claude'),
      ),
    );

    expect(merged.permissions).toEqual({ allow: ['Bash(git fetch *)'] });
    expect(merged.autoMemoryDirectory).toBe(path.resolve(directory, 'claude'));
  });

  it('refuses a non-object settings document', () => {
    expect(() => mergeClaudeSettings('[]', 'claude')).toThrow(/JSON object/);
  });
});

describe('memory bounds', () => {
  it('accepts a concise Markdown index and topic files', () => {
    const directory = memoryDirectory();
    mkdirSync(path.join(directory, 'topics'));
    writeFileSync(path.join(directory, 'MEMORY.md'), '# Memory\n\n- [Windows](topics/windows.md)\n');
    writeFileSync(path.join(directory, 'topics', 'windows.md'), '# Windows\n');

    expect(validateMemoryTree(directory)).toMatchObject({
      files: 2,
      indexLines: 3,
    });
  });

  it('counts a conventional trailing newline without inventing another line', () => {
    expect(countTextLines('first\nsecond\n')).toBe(2);
    expect(countTextLines('first\n\n')).toBe(2);
    expect(countTextLines('')).toBe(0);

    const directory = memoryDirectory();
    const twoHundredLines = `${Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n')}\n`;
    writeFileSync(path.join(directory, 'MEMORY.md'), twoHundredLines);
    expect(validateMemoryTree(directory).indexLines).toBe(200);
  });

  it('rejects non-Markdown artifacts', () => {
    const directory = memoryDirectory();
    writeFileSync(path.join(directory, 'MEMORY.md'), '# Memory\n');
    writeFileSync(path.join(directory, 'state.json'), '{}');

    expect(() => validateMemoryTree(directory)).toThrow(/Markdown-only/);
  });

  it('rejects a harness root that is a symlink', () => {
    const directory = memoryDirectory();
    const target = path.join(directory, 'target');
    const linkedRoot = path.join(directory, 'codex');
    mkdirSync(target);
    writeFileSync(path.join(target, 'MEMORY.md'), '# Memory\n');
    symlinkSync(target, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => validateMemoryTree(linkedRoot)).toThrow(/real directory/);
  });

  it('rejects Markdown files containing NUL bytes', () => {
    const directory = memoryDirectory();
    writeFileSync(path.join(directory, 'MEMORY.md'), '# Memory\n');
    writeFileSync(path.join(directory, 'binary.md'), Buffer.from('# Topic\ntext\0hidden'));

    expect(() => validateMemoryTree(directory)).toThrow(/NUL byte/);
  });

  it('rejects an index beyond the startup byte limit', () => {
    const directory = memoryDirectory();
    writeFileSync(path.join(directory, 'MEMORY.md'), `# Memory\n${'x'.repeat(INDEX_MAX_BYTES)}`);

    expect(() => validateMemoryTree(directory)).toThrow(/startup limit/);
  });
});
