import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEMORY_DIRECTORY = '.agent-memory';
/** The package.json field that names the project and its memory repository. */
export const CONFIG_FIELD = 'roveMemory';
export const INDEX_MAX_BYTES = 25 * 1024;
export const INDEX_MAX_LINES = 200;
export const TOPIC_MAX_BYTES = 256 * 1024;
export const AGENT_MAX_BYTES = 2 * 1024 * 1024;
/**
 * A lease that could not record a live holder process is "TTL-only": it is
 * stale once it has not been renewed for this long. A lease with a recorded
 * holder process ignores the TTL and is stale only when that process is gone.
 */
export const LEASE_TTL_MS = 30 * 60 * 1000;
/**
 * The operation lock, in the project's Git directory: one per repository,
 * taken by every command that changes the memory checkout or the lease.
 */
export const LOCK_FILE = 'rove-memory.lock';
/** The repository-local Git setting that can hold the memory remote instead of package.json. */
export const LOCAL_REMOTE_KEY = 'rove-memory.remote';
/** Test suites point the memory remote at a local bare repository through this variable. */
export const TEST_REMOTE_VARIABLE = 'ROVE_MEMORY_TEST_REMOTE';
export const LEASE_TTL_VARIABLE = 'ROVE_MEMORY_LEASE_TTL_MS';

const KNOWN_AUTHORS = {
  codex: { name: 'Codex', email: 'codex@openai.com' },
  claude: { name: 'Claude', email: 'noreply@anthropic.com' },
};
const DEFAULT_LOCK_IO = {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
};

/**
 * The project's memory configuration, from the `roveMemory` field of the
 * checkout's package.json:
 * `{ "project": "<display name>", "remote": "<private memory repository URL>" }`.
 * `remote` may be left out and kept in the repository's local Git
 * configuration instead (a public project need not publish the address of its
 * private memory).
 */
export function parseProjectConfig(raw, source = 'package.json') {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source} is not valid JSON.`, { cause: error });
  }
  const config = manifest && typeof manifest === 'object' ? manifest[CONFIG_FIELD] : undefined;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(
      `${source} has no "${CONFIG_FIELD}" object; add { "project": "<name>", "remote": "<private memory repository URL>" }.`,
    );
  }
  const { project, remote } = config;
  if (typeof project !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(project)) {
    throw new Error(`"${CONFIG_FIELD}.project" must be 1-64 letters, digits, spaces, dots, hyphens or underscores.`);
  }
  if (remote !== undefined && (typeof remote !== 'string' || !isNetworkRemote(remote))) {
    throw new Error(`"${CONFIG_FIELD}.remote" must be an https:// or SSH Git URL.`);
  }
  return { project, remote: remote ?? null };
}

/**
 * The memory remote of a project: `roveMemory.remote` from package.json, or
 * the repository's local `rove-memory.remote` setting. Both may be present
 * only when they name the same repository; neither is an error that says how
 * to set one. A local value is validated like a configured one, and is never
 * shown when it is invalid (it could carry a credential).
 */
export function chooseRemote(configured, local) {
  if (local !== null && !isNetworkRemote(local)) {
    throw new Error(`The local Git setting ${LOCAL_REMOTE_KEY} is not an https:// or SSH Git URL without credentials; fix it with git config --local ${LOCAL_REMOTE_KEY} <URL>.`);
  }
  if (configured && local && normalizeRemote(configured) !== normalizeRemote(local)) {
    throw new Error(`Two different memory remotes are configured: "${CONFIG_FIELD}.remote" in package.json (${configured}) and the local Git setting ${LOCAL_REMOTE_KEY} (${local}). Remove one of them.`);
  }
  const remote = configured ?? local;
  if (!remote) {
    throw new Error(`No memory remote is configured. Run setup once on this computer with --remote <private memory repository URL> (it is kept in this repository's local Git setting ${LOCAL_REMOTE_KEY}), or add "remote" to "${CONFIG_FIELD}" in package.json.`);
  }
  return remote;
}

function localRemote(checkoutRoot) {
  const result = git(['config', '--local', '--get', LOCAL_REMOTE_KEY], checkoutRoot, { allowFailure: true });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value || null;
}

/**
 * Store a remote given with `setup --remote` in the repository's local Git
 * configuration (shared by its linked worktrees, never committed). It is
 * refused when package.json already names the remote, or when a different
 * one is stored.
 */
function storeLocalRemote(checkoutRoot, configured, requested) {
  if (!isNetworkRemote(requested)) {
    throw new Error('--remote must be an https:// or SSH Git URL without credentials, a query or a fragment.');
  }
  if (configured) {
    if (normalizeRemote(configured) !== normalizeRemote(requested)) {
      throw new Error(`--remote differs from "${CONFIG_FIELD}.remote" in package.json (${configured}); this project's remote is set there.`);
    }
    return;
  }
  const stored = localRemote(checkoutRoot);
  if (stored && normalizeRemote(stored) !== normalizeRemote(requested)) {
    throw new Error(`This repository already stores ${LOCAL_REMOTE_KEY} = ${isNetworkRemote(stored) ? stored : '(an invalid value)'}; change it with git config --local ${LOCAL_REMOTE_KEY} <URL> if that is intended.`);
  }
  if (!stored) git(['config', '--local', LOCAL_REMOTE_KEY, requested], checkoutRoot);
}

/**
 * The lease's name, for the running command: derived from its memory
 * repository (see leaseNamespace), set once the remote is resolved.
 */
let leaseName = null;

/**
 * The name of a memory repository's lease (`<name>.lease`) and namespace
 * lock (`<name>.lock`) in the project's Git directory: the repository's own
 * name, lower-cased, made of letters, digits and hyphens, and always holding
 * "memory" so it can never be one of Git's own files (index, HEAD, config).
 * It depends only on the memory repository, which every worktree must share
 * (a checkout cloned from another remote is refused), so every worktree uses
 * the same lease; an earlier copy of this tool that named its files after
 * the memory repository shares them too.
 */
export function leaseNamespace(remote) {
  const last = normalizeRemote(remote).split('/').filter(Boolean).at(-1) ?? '';
  const name = last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
  return name.includes('memory') ? name : `${name ? `${name}-` : ''}memory`;
}

/** Read the project's configuration for a command: its name and configured memory remote. */
function projectContext(checkoutRoot) {
  const config = readProjectConfig(checkoutRoot);
  return { project: config.project, configuredRemote: config.remote };
}

/**
 * The command's memory remote (resolved for the test suites), which also
 * fixes the lease namespace from the remote the project chose.
 */
function resolvedRemote(checkoutRoot, configuredRemote) {
  const chosen = chooseRemote(configuredRemote, localRemote(checkoutRoot));
  leaseName = leaseNamespace(chosen);
  return resolveMemoryRemote(chosen);
}

/**
 * After the operation lock: the lease namespace's lock too (when it is a
 * different file), so a command also waits for an earlier tool that locks
 * only that file. Returns the release of both; on failure the operation lock
 * is the caller's to release.
 */
function withNamespaceLock(commonGitDirectory, agentId, operation, releaseOperation) {
  const namespaceLock = `${leaseName}.lock`;
  if (namespaceLock === LOCK_FILE) return releaseOperation;
  const releaseNamespace = acquireMemoryLock(commonGitDirectory, agentId, operation, DEFAULT_LOCK_IO, namespaceLock);
  return () => {
    try {
      releaseNamespace();
    } finally {
      releaseOperation();
    }
  };
}

/** The operation lock and the lease namespace's lock, in that order. */
function acquireLocks(commonGitDirectory, agentId, operation) {
  const releaseOperation = acquireMemoryLock(commonGitDirectory, agentId, operation);
  try {
    return withNamespaceLock(commonGitDirectory, agentId, operation, releaseOperation);
  } catch (error) {
    releaseOperation();
    throw error;
  }
}

/**
 * A remote is printed and written into Git configuration, so it can never
 * carry a credential: no user information beyond an SSH user name, no
 * percent-encoding, query or fragment, and a path of plain segments.
 */
function isNetworkRemote(value) {
  const remotePath = String.raw`[\w.~-]+(?:/[\w.~-]+)*`;
  return new RegExp(String.raw`^https://[\w.-]+(?::\d+)?/${remotePath}$`).test(value)
    || new RegExp(String.raw`^ssh://(?:[\w.-]+@)?[\w.-]+(?::\d+)?/${remotePath}$`).test(value)
    || new RegExp(String.raw`^[\w.-]+@[\w.-]+:${remotePath}$`).test(value);
}

export function readProjectConfig(checkoutRoot) {
  const file = path.join(checkoutRoot, 'package.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`No readable package.json in ${checkoutRoot}; rove-memory reads its "${CONFIG_FIELD}" field.`, { cause: error });
  }
  return parseProjectConfig(raw, file);
}

/**
 * Whether a remote override names a repository on this computer: an absolute
 * local path, never a URL, an SSH address, or a UNC/network path.
 */
function isLocalAbsolutePath(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (/^[\\/]{2}/.test(value)) return false;
  return path.isAbsolute(value);
}

/**
 * The memory remote: the configured one, unless the test suites point it at a
 * local bare repository through ROVE_MEMORY_TEST_REMOTE. That override is
 * honoured only for an absolute path on this computer, so an inherited
 * environment variable can never send a session's private memory to another
 * host; a real checkout that was cloned from GitHub refuses it as an
 * unexpected remote.
 */
export function resolveMemoryRemote(configured, env = process.env) {
  const override = env[TEST_REMOTE_VARIABLE]?.trim();
  if (!override) return configured;
  let local = override;
  if (override.startsWith('file://')) {
    try {
      local = fileURLToPath(override);
    } catch {
      return configured;
    }
  }
  return isLocalAbsolutePath(local) ? override : configured;
}

function leaseTtlMs() {
  const override = Number.parseInt(process.env[LEASE_TTL_VARIABLE] ?? '', 10);
  return Number.isSafeInteger(override) && override >= 0 ? override : LEASE_TTL_MS;
}

/**
 * Room for the largest output a command produces here: the patch of a whole
 * harness folder (at most 2 MiB of Markdown) with its context. spawnSync's
 * 1 MiB default would fail a legitimate update.
 */
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;

function run(command, args, cwd, { allowFailure = false, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    input,
    maxBuffer: MAX_COMMAND_OUTPUT,
  });

  if (result.error) {
    throw new Error(`Unable to run ${command}: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function git(args, cwd, options) {
  return run('git', args, cwd, options);
}

export function validateAgentId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) {
    throw new Error(
      'Agent id must be 1-32 lowercase letters, numbers, or hyphens and must start with a letter or number.',
    );
  }
  return value;
}

/**
 * One spelling per repository: two remotes compare equal only when they name
 * the same repository. The scheme, the account and the path keep their
 * identity (`alice@host:memory` and `bob@host:memory` are two repositories,
 * and so may be `https://host/memory` and `git@host:memory`); only the host
 * is case-insensitive. The one equivalence across schemes is github.com,
 * which documents that `https://github.com/<owner>/<repo>` and
 * `git@github.com:<owner>/<repo>` are the same repository. A local path
 * (the tests' bare repositories) is compared as written.
 */
export function normalizeRemote(value) {
  let rest = value.trim().replaceAll('\\', '/');
  let scheme;
  if (/^https?:\/\//i.test(rest)) {
    // http and https stay distinct: a plaintext transport is never the
    // configured (https-only) remote.
    scheme = /^https:/i.test(rest) ? 'https' : 'http';
    rest = rest.replace(/^https?:\/\//i, '');
  } else if (/^ssh:\/\//i.test(rest)) {
    scheme = 'ssh';
    rest = rest.replace(/^ssh:\/\//i, '');
  } else if (/^[^@/:]+@[^:/]+:/.test(rest)) {
    scheme = 'ssh';
    rest = rest.replace(/^([^@/:]+@[^:/]+):/, '$1/');
  } else {
    return rest.replace(/\/+$/, '').replace(/\.git$/, '');
  }
  rest = rest.replace(/\/+$/, '').replace(/\.git$/, '');
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const repositoryPath = slash < 0 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  const account = at < 0 ? '' : authority.slice(0, at);
  const host = authority.slice(at + 1).toLowerCase();
  const githubForm = (scheme === 'https' && account === '') || (scheme === 'ssh' && account === 'git');
  if (host === 'github.com' && githubForm) {
    return `github.com${repositoryPath}`;
  }
  return `${scheme}://${account ? `${account}@` : ''}${host}${repositoryPath}`;
}

/**
 * A URL as it may be shown: user information, a query and a fragment can
 * carry a credential, so they are masked.
 */
export function redactRemote(value) {
  return value
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1***@')
    .replace(/[?#].*$/, '?***');
}

export function mergeClaudeSettings(raw, memoryDirectory) {
  let settings = {};
  if (raw.trim()) {
    settings = JSON.parse(raw);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Claude settings must contain a JSON object.');
  }

  settings.autoMemoryDirectory = path.resolve(memoryDirectory);
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function parsePorcelainZ(output) {
  const records = output.split('\0');
  const entries = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    entries.push({ status, path: filePath });

    if (/[RC]/.test(status) && records[index + 1]) {
      entries.push({ status, path: records[index + 1] });
      index += 1;
    }
  }

  return entries;
}

/**
 * Git reports paths with "/" on every platform, so a backslash is part of a
 * file name, never a separator: "codex\x.md" is a top-level file, not one of
 * codex's.
 */
export function isAgentOwnedPath(filePath, agentId) {
  const normalized = filePath.replace(/^\.\//, '');
  return normalized.startsWith(`${agentId}/`);
}

export function hasMemoryToPublish(changes, unpublishedCommits) {
  return changes.length > 0 || unpublishedCommits > 0;
}

export function countTextLines(value) {
  if (value.length === 0) return 0;
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

export function validateMemoryBranch(branch) {
  if (branch !== 'main') {
    throw new Error(`Memory repository must stay on main, not ${branch || '(detached)'}.`);
  }
}

const COMMANDS = ['setup', 'status', 'sync', 'edit', 'release'];
const USAGE = 'Usage: rove-memory <setup|status|sync|edit|release> --agent <harness-id> [--message <text>] [--lease <token>] [--holder-pid <pid>] [--renew] [--reclaim-stale] [--remote <url> (setup)]';

export function parseArguments(argv) {
  // A package-manager separator ("pnpm memory -- sync ...") is not an option.
  const args = [...argv];
  while (args[0] === '--') args.shift();
  const [command, ...rest] = args;
  if (!COMMANDS.includes(command)) {
    throw new Error(USAGE);
  }

  const options = { renew: false, reclaimStale: false };
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === '--') {
      continue;
    } else if (option === '--agent') {
      options.agentId = rest[index + 1];
      index += 1;
    } else if (option === '--message') {
      options.message = rest[index + 1];
      index += 1;
    } else if (option === '--lease') {
      options.lease = rest[index + 1];
      index += 1;
    } else if (option === '--holder-pid') {
      const raw = rest[index + 1];
      const pid = Number.parseInt(raw ?? '', 10);
      if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== String(raw).trim()) {
        throw new Error(`--holder-pid must be a positive integer, not ${JSON.stringify(raw)}.`);
      }
      options.holderPid = pid;
      index += 1;
    } else if (option === '--renew') {
      options.renew = true;
    } else if (option === '--reclaim-stale') {
      options.reclaimStale = true;
    } else if (option === '--remote') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--remote requires the private memory repository URL.');
      }
      options.remote = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }

  if (options.lease !== undefined && !/^[0-9a-f-]{36}$/.test(options.lease)) {
    throw new Error('--lease must be the token printed by edit.');
  }
  if (options.renew && command !== 'edit') {
    throw new Error('--renew applies to edit only.');
  }
  if (options.reclaimStale && command !== 'edit') {
    throw new Error('--reclaim-stale applies to edit only.');
  }
  if (options.renew && options.reclaimStale) {
    throw new Error('--renew and --reclaim-stale are mutually exclusive.');
  }
  if (options.renew && !options.lease) {
    throw new Error('edit --renew requires --lease <token>.');
  }
  if (command === 'release' && !options.lease) {
    throw new Error('release requires --lease <token>.');
  }
  if (options.remote !== undefined && command !== 'setup') {
    throw new Error('--remote applies to setup only.');
  }

  return {
    command,
    agentId: validateAgentId(options.agentId),
    message: options.message,
    lease: options.lease,
    holderPid: options.holderPid,
    renew: options.renew,
    reclaimStale: options.reclaimStale,
    remote: options.remote,
  };
}

function discoverRoots(cwd) {
  const checkoutRoot = git(['rev-parse', '--show-toplevel'], cwd).stdout.trim();
  const commonGitDirectory = git(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    checkoutRoot,
  ).stdout.trim();

  if (path.basename(commonGitDirectory).toLowerCase() !== '.git') {
    throw new Error(`Unexpected Git common directory: ${commonGitDirectory}`);
  }

  return {
    checkoutRoot: path.resolve(checkoutRoot),
    canonicalRoot: path.dirname(path.resolve(commonGitDirectory)),
    commonGitDirectory: path.resolve(commonGitDirectory),
  };
}

function ensureExpectedMemoryRepository(memoryRoot, expectedRemote) {
  const inside = git(['rev-parse', '--is-inside-work-tree'], memoryRoot, {
    allowFailure: true,
  });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error(`${memoryRoot} exists but is not a Git working tree.`);
  }

  // Every URL Git would fetch from or push to — a second `url`, a `pushurl`,
  // an `insteadOf` / `pushInsteadOf` rewrite included — must be the
  // configured remote, or private memory could be published elsewhere.
  const expected = normalizeRemote(expectedRemote);
  for (const push of [false, true]) {
    const urls = remoteUrls(memoryRoot, push);
    if (urls.length !== 1 || normalizeRemote(urls[0]) !== expected) {
      throw new Error(
        `Refusing unexpected memory remote (${push ? 'push' : 'fetch'}: ${urls.map(redactRemote).join(', ') || 'none'}); expected ${expectedRemote}.`,
      );
    }
  }
}

/** The effective URLs of origin, after Git's URL rewriting. */
function remoteUrls(memoryRoot, push) {
  const result = git(
    ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', 'origin'],
    memoryRoot,
    { allowFailure: true },
  );
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function repositoryChanges(memoryRoot) {
  const output = git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    memoryRoot,
  ).stdout;
  return parsePorcelainZ(output);
}

function pendingCommitCount(memoryRoot) {
  const output = git(
    ['rev-list', '--count', 'origin/main..HEAD'],
    memoryRoot,
  ).stdout.trim();
  const count = Number.parseInt(output, 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Unexpected pending commit count: ${output}`);
  }
  return count;
}

export function parsePendingCommitPathOutput(output) {
  return [...new Set(output.split('\0').filter(Boolean))];
}

function pendingCommitPaths(memoryRoot, tip = 'HEAD') {
  const output = git(
    ['log', '--format=', '--name-only', '-z', '--no-renames', `origin/main..${tip}`],
    memoryRoot,
  ).stdout;
  return parsePendingCommitPathOutput(output);
}

function listMemoryFiles(root, relative = '') {
  const current = path.join(root, relative);
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const nextRelative = path.join(relative, entry.name);
    const absolute = path.join(root, nextRelative);
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`Portable memory cannot contain symlinks: ${nextRelative}`);
    }
    if (stats.isDirectory()) {
      files.push(...listMemoryFiles(root, nextRelative));
    } else if (stats.isFile()) {
      files.push({ relative: nextRelative, absolute, bytes: stats.size });
    }
  }
  return files;
}

export function validateMemoryTree(agentRoot) {
  const rootStats = lstatSync(agentRoot, { throwIfNoEntry: false });
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('Agent memory root must be a real directory.');
  }

  const indexPath = path.join(agentRoot, 'MEMORY.md');
  if (!existsSync(indexPath)) {
    throw new Error('Agent memory must contain MEMORY.md.');
  }

  const files = listMemoryFiles(agentRoot);
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.bytes;
    if (path.extname(file.relative).toLowerCase() !== '.md') {
      throw new Error(`Portable memory is Markdown-only: ${file.relative}`);
    }
    if (file.bytes > TOPIC_MAX_BYTES) {
      throw new Error(`Memory topic exceeds 256 KiB: ${file.relative}`);
    }
    const contents = readFileSync(file.absolute);
    if (contents.includes(0)) {
      throw new Error(`Portable memory must contain text Markdown (NUL byte found): ${file.relative}`);
    }
  }

  if (totalBytes > AGENT_MAX_BYTES) {
    throw new Error('Agent memory exceeds the 2 MiB folder limit.');
  }

  const index = readFileSync(indexPath, 'utf8');
  const indexBytes = Buffer.byteLength(index, 'utf8');
  const indexLines = countTextLines(index);
  if (indexBytes > INDEX_MAX_BYTES || indexLines > INDEX_MAX_LINES) {
    throw new Error(
      `MEMORY.md exceeds its startup limit (${indexLines} lines, ${indexBytes} bytes).`,
    );
  }

  return { files: files.length, totalBytes, indexBytes, indexLines };
}

function validateOwnedChanges(changes, agentId) {
  for (const change of changes) {
    if (!isAgentOwnedPath(change.path, agentId)) {
      throw new Error(
        `Refusing to touch another owner or shared policy path: ${change.path}`,
      );
    }
    if (path.extname(change.path).toLowerCase() !== '.md') {
      throw new Error(`Portable memory changes must be Markdown: ${change.path}`);
    }
  }
}

export function validateOwnedPendingPaths(paths, agentId) {
  for (const filePath of paths) {
    if (!isAgentOwnedPath(filePath, agentId)) {
      throw new Error(
        `Refusing to publish another owner's local commit: ${filePath}`,
      );
    }
    if (path.extname(filePath).toLowerCase() !== '.md') {
      throw new Error(`Portable memory commits must be Markdown: ${filePath}`);
    }
  }
}

function validateOwnedPendingCommits(memoryRoot, agentId) {
  validateOwnedPendingPaths(pendingCommitPaths(memoryRoot), agentId);
  return pendingCommitCount(memoryRoot);
}

function memoryGitDirectory(memoryRoot) {
  const gitDirectoryRaw = git(['rev-parse', '--git-dir'], memoryRoot).stdout.trim();
  return path.resolve(memoryRoot, gitDirectoryRaw);
}

function ensureNoGitOperation(memoryRoot) {
  const gitDirectory = memoryGitDirectory(memoryRoot);
  const markers = [
    'rebase-apply',
    'rebase-merge',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
  ];
  const active = markers.find((marker) => existsSync(path.join(gitDirectory, marker)));
  if (active) {
    throw new Error(
      `Memory repository has an unfinished Git operation (${active}). Resolve it explicitly before syncing.`,
    );
  }
}

export function acquireMemoryLock(
  commonGitDirectory,
  agentId,
  operation,
  lockIo = DEFAULT_LOCK_IO,
  fileName = LOCK_FILE,
) {
  const lockPath = path.join(commonGitDirectory, fileName);
  const lockToken = randomUUID();
  const lockContents = `${JSON.stringify({
    agent: agentId,
    operation,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: lockToken,
  })}\n`;
  let descriptor;

  try {
    descriptor = lockIo.openSync(lockPath, 'wx');
  } catch (error) {
    let owner = 'No readable owner metadata is available.';
    if (lockIo.existsSync(lockPath)) {
      try {
        const parsed = JSON.parse(lockIo.readFileSync(lockPath, 'utf8'));
        owner = `Recorded owner: agent=${parsed.agent ?? 'unknown'}, operation=${parsed.operation ?? 'unknown'}, pid=${parsed.pid ?? 'unknown'}, startedAt=${parsed.startedAt ?? 'unknown'}.`;
      } catch {
        owner = 'The existing lock metadata is unreadable.';
      }
    }
    throw new Error(
      `Unable to acquire the memory operation lock at ${lockPath}. ${owner} Inspect it before retrying; never delete an active lock.`,
      { cause: error },
    );
  }

  try {
    lockIo.writeFileSync(descriptor, lockContents, 'utf8');
    lockIo.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    const cleanupFailures = [];
    if (descriptor !== undefined) {
      try {
        lockIo.closeSync(descriptor);
      } catch (cleanupError) {
        cleanupFailures.push(`close failed: ${String(cleanupError)}`);
      }
    }
    try {
      lockIo.unlinkSync(lockPath);
    } catch (cleanupError) {
      cleanupFailures.push(`remove failed: ${String(cleanupError)}`);
    }
    const cleanup = cleanupFailures.length === 0
      ? 'The incomplete lock was removed.'
      : `Lock cleanup failed (${cleanupFailures.join('; ')}). Inspect ${lockPath} before retrying.`;
    throw new Error(
      `Unable to initialize the memory operation lock. ${cleanup}`,
      { cause: error },
    );
  }

  return () => {
    if (
      lockIo.existsSync(lockPath)
      && lockIo.readFileSync(lockPath, 'utf8') === lockContents
    ) {
      lockIo.unlinkSync(lockPath);
    }
  };
}

function commitAttribution(agentId) {
  const author = KNOWN_AUTHORS[agentId];
  if (!author) return [];
  return ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`];
}

function ensureMainBranch(memoryRoot) {
  const branch = git(['branch', '--show-current'], memoryRoot).stdout.trim();
  validateMemoryBranch(branch);
}

/**
 * Rebase local main onto origin/main, aborting a conflicted rebase before
 * reporting it. With `reapply`, a commit whose change upstream already
 * carries is replayed instead of skipped, so the rebased commits are exactly
 * the local ones (the publish loop proves that afterwards).
 */
export function rebaseOntoOrigin(memoryRoot, runGit = git, { reapply = false } = {}) {
  // --no-autostash: an inherited rebase.autoStash would stash another
  // session's working-tree edits and could leave them in conflict; with a
  // dirty tree the rebase refuses instead.
  const rebase = runGit(['rebase', '--no-autostash', ...(reapply ? ['--reapply-cherry-picks'] : []), 'origin/main'], memoryRoot, {
    allowFailure: true,
  });
  if (rebase.status === 0) return;

  const abort = runGit(['rebase', '--abort'], memoryRoot, {
    allowFailure: true,
  });
  const detail = (rebase.stderr || rebase.stdout).trim();
  const cleanup = abort.status === 0
    ? 'The rebase was aborted cleanly.'
    : `Automatic rebase cleanup also failed: ${(abort.stderr || abort.stdout).trim()}`;
  throw new Error(
    `Memory rebase conflicted; resolve the remote/local memory difference manually. ${cleanup}${detail ? ` Git reported: ${detail}` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Holder liveness
// ---------------------------------------------------------------------------

/**
 * Probe results are cached for the lifetime of this process: the CLI is a
 * one-shot process, so a pid cannot change state between two probes of the
 * same invocation, and the Windows probe costs a PowerShell start-up each
 * time. Tests reset the cache between cases.
 */
const processProbeCache = new Map();

export function resetProcessStartTimeCache() {
  processProbeCache.clear();
}

/**
 * Whether a process with this pid exists, decided by the kernel (signal 0),
 * never by the start-time probe: ESRCH is the only "gone" answer, and EPERM
 * (another user's process) still means it exists.
 */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * Probe a process: `{ state: 'gone' }` when no such process exists,
 * `{ state: 'alive', start }` when its start time could be read (pid + start
 * time defeats pid reuse: a different start time means a different process),
 * and `{ state: 'unknown', start: null }` when the process exists but the
 * start-time probe failed — a probe failure is never evidence that a holder
 * is gone.
 */
export function probeProcess(pid, { fresh = false } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'gone', start: null };
  if (!fresh && processProbeCache.has(pid)) return processProbeCache.get(pid);
  let value;
  if (!processExists(pid)) {
    value = { state: 'gone', start: null };
  } else {
    const start = probeProcessStartTime(pid);
    value = start ? { state: 'alive', start } : { state: 'unknown', start: null };
  }
  processProbeCache.set(pid, value);
  return value;
}

/** Back-compatible view of probeProcess: the start time, or null. */
export function processStartTime(pid) {
  return probeProcess(pid).start;
}

function probeProcessStartTime(pid) {
  if (process.platform === 'win32') {
    const result = run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
      ],
      undefined,
      { allowFailure: true },
    );
    const value = result.stdout.trim();
    return result.status === 0 && value ? value : null;
  }
  // Only what a process cannot change about itself identifies it: a process
  // may rename itself (process.title rewrites its command line). On Linux
  // that is the start time in clock ticks since boot (/proc/<pid>/stat);
  // elsewhere ps's start time.
  if (process.platform === 'linux') {
    try {
      const ticks = parseProcStatStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      if (ticks) return `ticks:${ticks}`;
    } catch {
      // Fall back to ps below.
    }
  }
  const result = run('ps', ['-o', 'lstart=', '-p', String(pid)], undefined, {
    allowFailure: true,
  });
  const value = result.stdout.trim();
  return result.status === 0 && value ? value : null;
}

/**
 * The start time (field 22) of a /proc/<pid>/stat line. The command name in
 * field 2 is in parentheses and may itself hold spaces and parentheses, so
 * the fields are counted after its last closing parenthesis.
 */
export function parseProcStatStartTime(stat) {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  // The first field after the name is field 3 (state), so field 22 is the 20th.
  const value = stat.slice(end + 1).trim().split(/\s+/)[19];
  return value && /^\d+$/.test(value) ? value : null;
}

/**
 * Pure liveness rule, stated once (README.md, "The edit lease"):
 * a lease with a recorded holder is live while that process exists with that
 * start time and stale only when it is gone; a lease without a holder pid is
 * TTL-only and stale once it has not been renewed within the TTL.
 */
export function classifyLease(lease, { now = Date.now(), probe = probeProcess, ttlMs = leaseTtlMs() } = {}) {
  if (lease.holderPid) {
    const probed = probe(lease.holderPid);
    if (probed.state === 'gone') {
      return { state: 'stale', mode: 'holder-pid', reason: `holder process ${lease.holderPid} is gone` };
    }
    if (probed.state === 'unknown') {
      // The process exists but its identity could not be read: a probe
      // failure must never dispossess a live holder.
      return { state: 'live', mode: 'holder-pid', reason: `holder process ${lease.holderPid} exists; its start time could not be read, so the lease is treated as live` };
    }
    if (probed.start === lease.holderStart) {
      return { state: 'live', mode: 'holder-pid', reason: `holder process ${lease.holderPid} is alive` };
    }
    return { state: 'stale', mode: 'holder-pid', reason: `pid ${lease.holderPid} now belongs to a different process` };
  }
  const renewedAt = Date.parse(lease.renewedAt ?? lease.createdAt ?? '');
  const age = Number.isFinite(renewedAt) ? now - renewedAt : Number.POSITIVE_INFINITY;
  if (age <= ttlMs) {
    return { state: 'live', mode: 'ttl-only', reason: `renewed ${Math.round(age / 1000)}s ago (TTL-only lease, no holder pid recorded)` };
  }
  return { state: 'stale', mode: 'ttl-only', reason: 'not renewed within the TTL (TTL-only lease, no holder pid recorded)' };
}

function leasePath(commonGitDirectory) {
  if (!leaseName) throw new Error('The lease namespace is not known before the memory remote is resolved.');
  return path.join(commonGitDirectory, `${leaseName}.lease`);
}

function readLease(commonGitDirectory) {
  const file = leasePath(commonGitDirectory);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    // A release/sync may unlink the file between an existence check and the
    // read; "gone" is the truthful answer, not "unreadable".
    if (error?.code === 'ENOENT') return null;
    throw new Error(`The memory edit lease at ${file} is unreadable; inspect it before retrying.`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The memory edit lease at ${file} is unreadable; inspect it before retrying.`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.agent !== 'string' || typeof parsed.token !== 'string') {
    throw new Error(`The memory edit lease at ${file} is malformed; inspect it before retrying.`);
  }
  return parsed;
}

function writeLease(commonGitDirectory, lease) {
  // Atomic replace: `status` reads the lease without the operation lock and
  // must never observe a truncated document.
  const target = leasePath(commonGitDirectory);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
  renameSync(temporary, target);
}

function removeLease(commonGitDirectory) {
  const file = leasePath(commonGitDirectory);
  if (existsSync(file)) unlinkSync(file);
}

function describeLease(lease, classification) {
  const holder = lease.holderPid ? `pid ${lease.holderPid}` : 'no holder pid (TTL-only)';
  return `agent=${lease.agent}, ${holder}, created ${lease.createdAt}, renewed ${lease.renewedAt}, checkout ${lease.checkout} — ${classification.state} (${classification.reason})`;
}

/** Returns the live lease, or null when no lease exists or it is stale. */
function liveLease(commonGitDirectory) {
  const lease = readLease(commonGitDirectory);
  if (!lease) return null;
  const classification = classifyLease(lease);
  return classification.state === 'live' ? { lease, classification } : null;
}

function requireOwnLease(commonGitDirectory, agentId, token, command, { fresh = false } = {}) {
  const lease = readLease(commonGitDirectory);
  if (!lease) {
    throw new Error(`No memory edit lease exists. Run edit --agent ${agentId} first, then ${command} with the token it prints.`);
  }
  // `fresh` bypasses the per-process probe cache: a re-check late in a long
  // command (right before a push) must see a holder that died meanwhile.
  const classification = classifyLease(lease, { probe: (pid) => probeProcess(pid, { fresh }) });
  if (lease.agent !== agentId || lease.token !== token) {
    throw new Error(
      `The memory edit lease is not yours (${describeLease(lease, classification)}). ${command} requires the token printed by your own edit.`,
    );
  }
  if (classification.state !== 'live') {
    // A stale token authorizes nothing: a dead holder's token must not
    // publish, and an expired TTL-only token must not revive itself. The
    // holder that still has its edits in the tree re-takes the lease with
    // `edit --reclaim-stale --lease <token>`, which adopts them.
    throw new Error(
      `The memory edit lease is stale (${describeLease(lease, classification)}); ${command} refuses a stale token. If these are your own edits, run edit --agent ${agentId} --reclaim-stale --lease ${token} to re-take the lease and keep them.`,
    );
  }
  return lease;
}

/**
 * Drop the lease only when the folder is really clean *now*: the operation
 * lock does not stop ordinary file writes, so an edit that arrived while
 * sync/release ran must not be abandoned for the next session to inherit.
 */
function finalizeLease(memoryRoot, commonGitDirectory, agentId, done, { onKeep } = {}) {
  const keep = (reason) => {
    onKeep?.();
    console.warn(`${done} ${reason}; the lease is kept — sync again to publish.`);
    return false;
  };
  // "Clean" means no working-tree edits AND nothing unpublished: a commit
  // that landed after the caller's own count must not be orphaned either.
  const unfinished = () => {
    const all = repositoryChanges(memoryRoot);
    const late = changesUnder(all, agentId);
    if (late.length > 0) return `Edits arrived under ${agentId}/ meanwhile (${formatChanges(late)})`;
    const pending = pendingCommitCount(memoryRoot);
    if (pending > 0) return `${pending} commit(s) under ${agentId}/ are still unpublished`;
    if (all.length > 0) {
      // Not this holder's to keep the lease for, but never silent: the next
      // edit will refuse the dirty checkout until their owner resolves them.
      console.warn(`Unsynced changes outside ${agentId}/ exist in the shared memory checkout (${formatChanges(all)}); they belong to their own harness and block the next edit until synced or reverted.`);
    }
    return null;
  };
  const before = unfinished();
  if (before) return keep(before);

  // The check and the unlink are two filesystem operations and ordinary
  // holder writes are not covered by the operation lock, so look once more
  // after the unlink and put the lease back if an edit slipped in between.
  const lease = readLease(commonGitDirectory);
  removeLease(commonGitDirectory);
  let after;
  try {
    after = unfinished();
  } catch (error) {
    // If the second look itself fails, the safe state is "lease still held".
    if (lease) writeLease(commonGitDirectory, lease);
    throw error;
  }
  if (after && lease) {
    writeLease(commonGitDirectory, lease);
    return keep(after);
  }
  // A write that lands after this point is unleased; the tombstone lets its
  // holder prove ownership with the released token and adopt it (see edit).
  if (lease) writeTombstone(commonGitDirectory, lease);
  console.log(`${done} Lease released.`);
  return true;
}

/** One tombstone per harness, so a release never overwrites another harness's. */
function tombstonePath(commonGitDirectory, agentId) {
  return `${leasePath(commonGitDirectory)}.released.${agentId}`;
}

function writeTombstone(commonGitDirectory, lease) {
  const target = tombstonePath(commonGitDirectory, lease.agent);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ agent: lease.agent, token: lease.token, releasedAt: new Date().toISOString() })}\n`,
    'utf8',
  );
  renameSync(temporary, target);
}

function readTombstone(commonGitDirectory, agentId) {
  try {
    const parsed = JSON.parse(readFileSync(tombstonePath(commonGitDirectory, agentId), 'utf8'));
    return parsed && typeof parsed.agent === 'string' && typeof parsed.token === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate the harness folder as COMMITTED in `ref` (not the mutable working
 * tree): a holder write that lands between the working-tree validation and
 * `git add` must still pass the Markdown-only, size, NUL, and index bounds
 * before anything reaches origin/main.
 */
export function validateCommittedTree(memoryRoot, ref, agentId) {
  const listing = git(['ls-tree', '-r', '-l', '-z', ref, '--', agentId], memoryRoot).stdout;
  const entries = listing.split('\0').filter(Boolean).map((line) => {
    // With -z the path is unquoted and may itself contain a tab: split on
    // the FIRST tab only, never on every tab.
    const tab = line.indexOf('\t');
    const meta = line.slice(0, tab);
    const filePath = line.slice(tab + 1);
    const [mode, type, sha, size] = meta.trim().split(/\s+/);
    return { mode, type, sha, size: Number.parseInt(size, 10), path: filePath };
  });
  let totalBytes = 0;
  let index = null;
  for (const entry of entries) {
    if (/[\u0000-\u001f\u007f]/.test(entry.path)) {
      throw new Error(`Committed memory contains a path with control characters: ${JSON.stringify(entry.path)}`);
    }
    if (entry.type !== 'blob' || entry.mode === '120000') {
      throw new Error(`Committed memory contains a non-file entry: ${entry.path}`);
    }
    if (path.extname(entry.path).toLowerCase() !== '.md') {
      throw new Error(`Committed memory is Markdown-only: ${entry.path}`);
    }
    if (entry.size > TOPIC_MAX_BYTES) {
      throw new Error(`Committed memory topic exceeds 256 KiB: ${entry.path}`);
    }
    totalBytes += entry.size;
    const blob = git(['cat-file', 'blob', entry.sha], memoryRoot).stdout;
    if (blob.includes('\0')) {
      throw new Error(`Committed memory must contain text Markdown (NUL byte found): ${entry.path}`);
    }
    if (entry.path.replaceAll('\\', '/') === `${agentId}/MEMORY.md`) index = blob;
  }
  if (index === null) {
    throw new Error(`Committed memory must contain ${agentId}/MEMORY.md.`);
  }
  if (totalBytes > AGENT_MAX_BYTES) {
    throw new Error('Committed memory exceeds the 2 MiB folder limit.');
  }
  const indexBytes = Buffer.byteLength(index, 'utf8');
  const indexLines = countTextLines(index);
  if (indexBytes > INDEX_MAX_BYTES || indexLines > INDEX_MAX_LINES) {
    throw new Error(`Committed MEMORY.md exceeds its startup limit (${indexLines} lines, ${indexBytes} bytes).`);
  }
  return { files: entries.length, totalBytes, indexBytes, indexLines };
}

function folderTree(memoryRoot, ref, agentId) {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}:${agentId}`], memoryRoot, {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function revision(memoryRoot, ref) {
  return git(['rev-parse', '--verify', '--quiet', ref], memoryRoot).stdout.trim();
}

function isAncestor(memoryRoot, ancestor, descendant) {
  return git(['merge-base', '--is-ancestor', ancestor, descendant], memoryRoot, {
    allowFailure: true,
  }).status === 0;
}

function fetchOrigin(memoryRoot) {
  git(['fetch', 'origin', 'main:refs/remotes/origin/main'], memoryRoot);
}

function baselineFromOrigin(memoryRoot, agentId) {
  return {
    commit: revision(memoryRoot, 'origin/main'),
    tree: folderTree(memoryRoot, 'origin/main', agentId),
  };
}

function changesUnder(changes, agentId) {
  return changes.filter((change) => isAgentOwnedPath(change.path, agentId));
}

function formatChanges(changes) {
  return changes.map((change) => change.path).join(', ');
}

// ---------------------------------------------------------------------------
// Bootstrap and publish loop
// ---------------------------------------------------------------------------

/**
 * Validate, as committed, every commit that pushing `tip` would publish, and
 * return how many there are. `tip` is a SHA the caller holds, never the
 * mutable HEAD, so what is validated is what will be pushed. Memory history
 * is linear and every commit changes something: a merge or an empty commit
 * is refused, so a rebase never has a commit of the caller's to drop.
 */
function validatePendingCommits(memoryRoot, agentId, tip) {
  validateOwnedPendingPaths(pendingCommitPaths(memoryRoot, tip), agentId);
  const pending = commitsIn(memoryRoot, `origin/main..${tip}`);
  const merges = git(['rev-list', '--merges', `origin/main..${tip}`], memoryRoot).stdout.trim();
  if (merges) {
    throw new Error(`Memory history must be linear; refusing to publish merge commit ${merges.split(/\r?\n/)[0].slice(0, 12)}.`);
  }
  for (const commit of pending) {
    validateCommittedTree(memoryRoot, commit, agentId);
    if (git(['diff-tree', '--quiet', `${commit}^`, commit], memoryRoot, { allowFailure: true }).status === 0) {
      throw new Error(`Refusing to publish empty commit ${commit.slice(0, 12)}: every memory commit must change something.`);
    }
  }
  return pending.length;
}

/** Commits in a range, oldest first. */
function commitsIn(memoryRoot, range) {
  return git(['rev-list', '--reverse', range], memoryRoot).stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * Commit the harness folder on top of `parent` — the HEAD the caller checked —
 * and return that commit's SHA. If any other commit is in between, nothing is
 * adopted. The commit is validated by its SHA, never by the mutable HEAD,
 * and a commit that fails validation is undone while it is still HEAD (its
 * files stay in the tree for inspection).
 */
function commitOwnFolder(memoryRoot, agentId, message, undone, parent) {
  const before = parent;
  git([...commitAttribution(agentId), 'commit', '-m', message, '--', agentId], memoryRoot);
  const commit = revision(memoryRoot, 'HEAD');
  const committedOn = git(['rev-parse', '--verify', '--quiet', `${commit}^`], memoryRoot, { allowFailure: true }).stdout.trim();
  if (committedOn !== before) {
    throw new Error(
      `HEAD of the shared memory checkout moved while your commit was being made (another session committed); nothing was adopted or published. Inspect ${memoryRoot} before trying again.`,
    );
  }
  try {
    validateCommittedTree(memoryRoot, commit, agentId);
  } catch (error) {
    if (revision(memoryRoot, 'HEAD') === commit) {
      git(['reset', '--soft', before], memoryRoot);
      git(['reset', '--quiet', '--', agentId], memoryRoot);
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${undone}`);
  }
  return commit;
}

/**
 * Push the caller's own commit to origin/main with the fetch → rebase → push
 * retry loop. `own()` is the commit the caller created (or adopted) and
 * validated: HEAD must still be exactly that commit before a rebase and
 * before the push, so a commit another session made meanwhile is never
 * carried along, and after a rebase every commit that will be pushed is
 * validated again as committed before `onRebased` makes the new HEAD the
 * caller's own. `classify` is called after every fetch and may return
 * 'published' (stop, nothing left to push), 'push' (continue), or throw to
 * refuse. The remote is checked again right before each push.
 */
function publishLoop(memoryRoot, agentId, remote, { own, hint, classify = () => 'push', onRebased = () => {}, beforePush = () => {} }) {
  const requireOwnHead = (moment) => {
    if (revision(memoryRoot, 'HEAD') !== own()) {
      throw new Error(
        `A commit that is not yours became HEAD of the shared memory checkout ${moment}; nothing was pushed. ${hint}`,
      );
    }
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    fetchOrigin(memoryRoot);
    validateOwnedPendingPaths(pendingCommitPaths(memoryRoot), agentId);
    if (classify() === 'published') return 'published';

    if (!isAncestor(memoryRoot, 'origin/main', 'HEAD')) {
      requireOwnHead('before the rebase');
      // The invariant that proves the rebase carried only the caller's own
      // commits. Every caller's `classify` has refused by now if the
      // caller's folder upstream differs from the one the caller's commits
      // were made on (sync: the lease baseline; the bootstrap publish: no
      // folder at all); the caller's commits touch only that folder, form a
      // linear history and each changes it (validated). So replaying them
      // all (none skipped as already upstream) onto origin/main must give
      // the same commits one for one: each rebased commit leaves the folder
      // exactly as the caller's commit at the same position did. A commit of
      // anyone else's in the result breaks that sequence.
      validatePendingCommits(memoryRoot, agentId, own());
      const ownFolders = commitsIn(memoryRoot, `origin/main..${own()}`)
        .map((commit) => folderTree(memoryRoot, commit, agentId));
      rebaseOntoOrigin(memoryRoot, git, { reapply: true });
      // The rebased SHA is taken once, validated, and adopted by that SHA:
      // a commit that lands afterwards is not part of it, and the push
      // checks HEAD against it again.
      const rebased = revision(memoryRoot, 'HEAD');
      validatePendingCommits(memoryRoot, agentId, rebased);
      const rebasedFolders = commitsIn(memoryRoot, `origin/main..${rebased}`)
        .map((commit) => folderTree(memoryRoot, commit, agentId));
      if (
        rebasedFolders.length !== ownFolders.length
        || rebasedFolders.some((tree, position) => tree !== ownFolders[position])
      ) {
        throw new Error(
          `The rebase carried a commit that is not yours; nothing was pushed. ${hint}`,
        );
      }
      onRebased(rebased);
    }
    if (pendingCommitCount(memoryRoot) === 0) return 'published';

    // Push the exact commit that was validated, never the symbolic HEAD: a
    // raw concurrent commit between validation and push must not ride along.
    beforePush();
    requireOwnHead('before the push');
    ensureExpectedMemoryRepository(memoryRoot, remote);
    const target = own();
    const push = git(['push', 'origin', `${target}:main`], memoryRoot, { allowFailure: true });
    if (push.status === 0) return 'pushed';
    if (attempt === 3) {
      const detail = (push.stderr || push.stdout).trim();
      throw new Error(
        `Memory push failed after 3 attempts; ${pendingCommitCount(memoryRoot)} local commit(s) remain unpublished${detail ? `: ${detail}` : ''}`,
      );
    }
  }
  return 'pushed';
}

function bootstrapAgentFolder(memoryRoot, agentId, project, remote) {
  const agentRoot = path.join(memoryRoot, agentId);
  mkdirSync(agentRoot, { recursive: true });
  writeFileSync(
    path.join(agentRoot, 'MEMORY.md'),
    `# ${agentId} memory for ${project}\n\nNo durable entries yet.\n`,
    'utf8',
  );
  validateMemoryTree(agentRoot);
  git(['add', '--all', '--', agentId], memoryRoot);
  // Same rule as sync: what was committed is validated, not what was looked
  // at a moment ago, and only that commit is published. Setup bootstraps only
  // right after a fast-forward with nothing unpublished, so the commit's
  // parent must be the recorded origin/main.
  const commit = commitOwnFolder(
    memoryRoot,
    agentId,
    `${agentId}: initialize ${project} memory folder`,
    'The bootstrap commit was undone; nothing was published.',
    revision(memoryRoot, 'origin/main'),
  );
  publishOwnCommits(memoryRoot, agentId, remote, commit);
}

/**
 * Publish the folder's unpublished commits up to `head`, a SHA the caller
 * validated — the bootstrap commit, or commits whose earlier push failed.
 * Only that SHA is ever pushed; a rebase is validated again before it is
 * adopted.
 */
function publishOwnCommits(memoryRoot, agentId, remote, head) {
  let own = head;
  publishLoop(memoryRoot, agentId, remote, {
    own: () => own,
    hint: `Inspect the memory checkout, then run setup --agent ${agentId} again.`,
    // The folder must still be absent upstream: if another machine published
    // it meanwhile, these commits are not rebased here (a rebase over the
    // caller's own folder could drop or merge them); they stay local and edit
    // adopts them under a lease, so sync publishes them against a baseline.
    classify: () => {
      if (isAncestor(memoryRoot, own, 'origin/main')) return 'published';
      if (folderTree(memoryRoot, 'origin/main', agentId)) {
        throw new Error(
          `Another machine already published ${agentId}/ to origin/main; nothing was pushed and your local commits are kept. Run edit --agent ${agentId} to adopt them under a lease, then sync.`,
        );
      }
      return 'push';
    },
    onRebased: (rebasedHead) => {
      own = rebasedHead;
    },
  });
}

function configureClaude(checkoutRoot, memoryRoot) {
  const settingsDirectory = path.join(checkoutRoot, '.claude');
  const settingsPath = path.join(settingsDirectory, 'settings.local.json');
  const raw = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '';
  const next = mergeClaudeSettings(raw, path.join(memoryRoot, 'claude'));

  if (raw === next) return false;
  mkdirSync(settingsDirectory, { recursive: true });
  writeFileSync(settingsPath, next, 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function setup(agentId, cwd, requestedRemote) {
  const { checkoutRoot, canonicalRoot, commonGitDirectory } = discoverRoots(cwd);
  const { project, configuredRemote } = projectContext(checkoutRoot);
  const memoryRoot = path.join(canonicalRoot, MEMORY_DIRECTORY);
  const releaseOperation = acquireMemoryLock(commonGitDirectory, agentId, 'setup');
  let remote;
  let releaseLock;
  try {
    // Under the operation lock: two setups never both see "no remote stored"
    // and then store different ones.
    if (requestedRemote !== undefined) storeLocalRemote(checkoutRoot, configuredRemote, requestedRemote);
    remote = resolvedRemote(checkoutRoot, configuredRemote);
    releaseLock = withNamespaceLock(commonGitDirectory, agentId, 'setup', releaseOperation);
  } catch (error) {
    releaseOperation();
    throw error;
  }
  let published = null;
  let configuredClaude = false;
  let deferredBootstrap = false;
  let skippedFastForward = null;

  try {
    if (!existsSync(memoryRoot)) {
      git(['clone', remote, memoryRoot], checkoutRoot);
    }
    ensureExpectedMemoryRepository(memoryRoot, remote);
    ensureMainBranch(memoryRoot);

    const live = liveLease(commonGitDirectory);
    const existingChanges = repositoryChanges(memoryRoot);
    const unpublishedCommits = pendingCommitCount(memoryRoot);
    if (live) {
      // A live lease pins the shared checkout: never move HEAD beneath the
      // holder's baseline. The session still starts, read-only on the
      // current tree; a later edit is fenced normally.
      skippedFastForward = describeLease(live.lease, live.classification);
    } else if (existingChanges.length === 0 && unpublishedCommits === 0) {
      git(['pull', '--ff-only', '--no-autostash', 'origin', 'main'], memoryRoot);
    } else {
      console.warn(
        `Memory repository has unsynced state (${existingChanges.length} changed paths, ${unpublishedCommits} unpublished commits); setup did not pull from GitHub.`,
      );
    }

    const agentRoot = path.join(memoryRoot, agentId);
    const existingRoot = lstatSync(agentRoot, { throwIfNoEntry: false });
    if (existingRoot) {
      if (existingRoot.isSymbolicLink() || !existingRoot.isDirectory()) {
        throw new Error(`Agent memory root must be a real directory: ${agentId}/`);
      }
      if (live) {
        // The holder may be mid-write: validate the committed snapshot the
        // read-only session will actually rely on, not the mutable tree.
        if (folderTree(memoryRoot, 'HEAD', agentId)) validateCommittedTree(memoryRoot, 'HEAD', agentId);
      } else {
        validateMemoryTree(agentRoot);
        if (unpublishedCommits > 0 && existingChanges.length === 0 && !folderTree(memoryRoot, 'origin/main', agentId)) {
          // A bootstrap whose push failed: the folder exists only in local
          // commits, and edit cannot start until it is published. Publish
          // those commits now, validated as committed, instead of leaving
          // the harness with no way forward.
          const head = revision(memoryRoot, 'HEAD');
          validatePendingCommits(memoryRoot, agentId, head);
          publishOwnCommits(memoryRoot, agentId, remote, head);
          published = 'published its earlier unpublished commits';
        }
      }
    } else if (live) {
      deferredBootstrap = true;
    } else {
      if (existingChanges.length > 0 || unpublishedCommits > 0) {
        throw new Error(
          `Cannot create ${agentId}/ while the memory repository has unsynced state (${existingChanges.length} changed paths, ${unpublishedCommits} unpublished commits).`,
        );
      }
      bootstrapAgentFolder(memoryRoot, agentId, project, remote);
      published = 'created and published';
    }

    configuredClaude = agentId === 'claude'
      ? configureClaude(checkoutRoot, memoryRoot)
      : false;
  } finally {
    releaseLock();
  }

  console.log(`Memory repository: ${memoryRoot}`);
  if (skippedFastForward) {
    console.warn(
      `A live memory edit lease exists (${skippedFastForward}); setup left the shared checkout where it is (no fast-forward). Memory is readable; edits wait for that lease.`,
    );
  }
  if (deferredBootstrap) {
    console.warn(
      `Agent folder ${agentId}/ does not exist yet and cannot be created under a live lease; rerun setup once the lease clears.`,
    );
  } else {
    console.log(`Agent folder: ${path.join(memoryRoot, agentId)}${published ? ` (${published})` : ''}`);
  }
  if (agentId === 'claude') {
    console.log(`Claude auto memory: ${configuredClaude ? 'configured' : 'already configured'}`);
  }
}

function status(agentId, cwd) {
  const { checkoutRoot, canonicalRoot, commonGitDirectory } = discoverRoots(cwd);
  const { project, configuredRemote } = projectContext(checkoutRoot);
  const remote = resolvedRemote(checkoutRoot, configuredRemote);
  const memoryRoot = path.join(canonicalRoot, MEMORY_DIRECTORY);
  console.log(`Project: ${project} (memory remote ${remote}${configuredRemote ? '' : `, from the local Git setting ${LOCAL_REMOTE_KEY}`})`);
  console.log(`Canonical checkout: ${canonicalRoot}`);
  console.log(`Current checkout: ${checkoutRoot}`);
  console.log(`Memory repository: ${memoryRoot}`);

  if (!existsSync(memoryRoot)) {
    console.log('Repository status: missing');
    return;
  }

  ensureExpectedMemoryRepository(memoryRoot, remote);
  const agentRoot = path.join(memoryRoot, agentId);
  console.log(`Agent folder: ${existsSync(agentRoot) ? 'present' : 'missing'}`);
  let boundsError;
  if (existsSync(agentRoot)) {
    try {
      const summary = validateMemoryTree(agentRoot);
      console.log(
        `Memory bounds: ${summary.files} files, ${summary.totalBytes} bytes; index ${summary.indexLines} lines/${summary.indexBytes} bytes`,
      );
    } catch (error) {
      boundsError = error instanceof Error ? error.message : String(error);
      console.log(`Memory bounds: invalid — ${boundsError}`);
    }
  }

  const changes = repositoryChanges(memoryRoot);
  console.log(`Repository changes: ${changes.length === 0 ? 'clean' : changes.map((entry) => entry.path).join(', ')}`);
  const unpublishedCommits = pendingCommitCount(memoryRoot);
  console.log(
    `Publish state: ${unpublishedCommits === 0 ? 'no local commits pending recorded origin/main' : `${unpublishedCommits} local commit${unpublishedCommits === 1 ? '' : 's'} not published to recorded origin/main`}`,
  );

  const lease = readLease(commonGitDirectory);
  if (!lease) {
    console.log('Edit lease: none');
  } else {
    const classification = classifyLease(lease);
    // Ownership is per session (token + holder process), not per harness:
    // another session of this harness is still "not yours".
    const ownership = lease.agent === agentId ? 'this harness — yours only if you hold its token' : 'another harness';
    console.log(`Edit lease: ${classification.state} (${ownership}) — ${describeLease(lease, classification)}`);
  }

  if (agentId === 'claude') {
    const settingsPath = path.join(checkoutRoot, '.claude', 'settings.local.json');
    const expected = path.resolve(memoryRoot, 'claude');
    let configured = false;
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      configured = path.resolve(parsed.autoMemoryDirectory ?? '') === expected;
    }
    console.log(`Claude auto memory: ${configured ? 'configured' : 'not configured in this checkout'}`);
  }

  if (boundsError) {
    throw new Error(`Memory status completed with an invalid agent folder: ${boundsError}`);
  }
}

function requireMemoryReady(memoryRoot, agentId, remote) {
  if (!existsSync(memoryRoot)) {
    throw new Error(`Memory repository is missing. Run setup for ${agentId} first.`);
  }
  ensureExpectedMemoryRepository(memoryRoot, remote);
  ensureNoGitOperation(memoryRoot);
  ensureMainBranch(memoryRoot);
  const agentRoot = path.join(memoryRoot, agentId);
  if (!existsSync(agentRoot)) {
    throw new Error(`Agent folder ${agentId}/ is missing. Run setup first.`);
  }
  return agentRoot;
}

function edit(agentId, { holderPid, renew, lease: token, reclaimStale }, cwd) {
  const { checkoutRoot, canonicalRoot, commonGitDirectory } = discoverRoots(cwd);
  const remote = resolvedRemote(checkoutRoot, projectContext(checkoutRoot).configuredRemote);
  const memoryRoot = path.join(canonicalRoot, MEMORY_DIRECTORY);
  const releaseLock = acquireLocks(commonGitDirectory, agentId, renew ? 'edit --renew' : 'edit');
  try {
    requireMemoryReady(memoryRoot, agentId, remote);
    if (renew) {
      renewLease(memoryRoot, commonGitDirectory, agentId, token);
      return;
    }

    const existing = readLease(commonGitDirectory);
    let previousOwner = null;
    if (existing) {
      const classification = classifyLease(existing);
      if (classification.state === 'live') {
        // The same holder process asking again (its earlier output was lost)
        // gets its token back instead of being locked out of its own lease.
        if (
          existing.agent === agentId
          && holderPid
          && existing.holderPid === holderPid
          && existing.holderStart === probeProcess(holderPid).start
        ) {
          existing.renewedAt = new Date().toISOString();
          writeLease(commonGitDirectory, existing);
          console.log(`This process already holds the memory edit lease for ${agentId}; re-issuing its token.`);
          console.log(`Lease token: ${existing.token}`);
          console.log(`Baseline: origin/main ${existing.baseline.commit.slice(0, 12)}, ${agentId}/ tree ${existing.baseline.tree.slice(0, 12)}`);
          return;
        }
        throw new Error(
          `A live memory edit lease already exists (${describeLease(existing, classification)}). Wait for it, or for its holder to release it.`,
        );
      }
      if (!reclaimStale) {
        throw new Error(
          `A stale memory edit lease exists (${describeLease(existing, classification)}). Confirm its holder is gone, then rerun edit with --reclaim-stale.`,
        );
      }
      previousOwner = describeLease(existing, classification);
    }

    let holderStart = null;
    if (holderPid) {
      const probed = probeProcess(holderPid);
      if (probed.state === 'gone') {
        throw new Error(`--holder-pid ${holderPid} is not a running process; pass the pid of your live harness session.`);
      }
      if (probed.state === 'unknown') {
        throw new Error(`The start time of process ${holderPid} could not be read, so it cannot identify a lease holder; omit --holder-pid to take a TTL-only lease.`);
      }
      holderStart = probed.start;
    }

    // Re-taking your own stale lease with its token: the token proves the
    // unsynced edits in the tree are yours, so they are kept, the baseline
    // and holder commit carry over, and only the token and holder rotate.
    if (existing && token && existing.agent === agentId && existing.token === token) {
      const now = new Date().toISOString();
      const adopted = {
        ...existing,
        token: randomUUID(),
        holderPid: holderPid ?? null,
        holderStart,
        checkout: checkoutRoot,
        renewedAt: now,
      };
      writeLease(commonGitDirectory, adopted);
      console.warn(`Re-took your own stale memory edit lease (${previousOwner}); its old token no longer works.`);
      console.log(`Memory edit lease acquired for ${agentId}${holderPid ? ` (holder pid ${holderPid})` : ' (TTL-only: no --holder-pid given)'}; unsynced edits kept.`);
      console.log(`Lease token: ${adopted.token}`);
      console.log(`Baseline: origin/main ${adopted.baseline.commit.slice(0, 12)}, ${agentId}/ tree ${adopted.baseline.tree.slice(0, 12)}`);
      console.log(`Publish with: pnpm memory sync --agent ${agentId} --lease ${adopted.token} --message "${agentId}: <summary>"`);
      return;
    }

    // Clean-folder precondition: a foreign unsynced edit can never be absorbed
    // into the lease baseline. Unpublished commits are different — they are
    // already attributed to this harness's folder and are adopted (this is
    // the crash-recovery path after a stale reclaim).
    const changes = repositoryChanges(memoryRoot);
    const tombstone = !existing && token ? readTombstone(commonGitDirectory, agentId) : null;
    if (changes.length > 0 && tombstone && tombstone.agent === agentId && tombstone.token === token
      && changes.every((change) => isAgentOwnedPath(change.path, agentId))) {
      // The edits landed after the previous lease was released; the released
      // token proves they are that holder's, so they are adopted under a new
      // lease whose baseline is the tree that was published at release time.
      validateOwnedPendingCommits(memoryRoot, agentId);
      const now = new Date().toISOString();
      const adopted = {
        agent: agentId,
        token: randomUUID(),
        holderPid: holderPid ?? null,
        holderStart,
        checkout: checkoutRoot,
        createdAt: now,
        renewedAt: now,
        baseline: { commit: revision(memoryRoot, 'HEAD'), tree: folderTree(memoryRoot, 'HEAD', agentId) },
        commit: pendingCommitCount(memoryRoot) > 0 ? revision(memoryRoot, 'HEAD') : null,
      };
      writeLease(commonGitDirectory, adopted);
      unlinkSync(tombstonePath(commonGitDirectory, agentId));
      console.warn('Adopted edits that landed after your previous lease was released (proved by its token).');
      console.log(`Memory edit lease acquired for ${agentId}${holderPid ? ` (holder pid ${holderPid})` : ' (TTL-only: no --holder-pid given)'}; unsynced edits kept.`);
      console.log(`Lease token: ${adopted.token}`);
      console.log(`Publish with: pnpm memory sync --agent ${agentId} --lease ${adopted.token} --message "${agentId}: <summary>"`);
      return;
    }
    if (changes.length > 0) {
      throw new Error(
        `Refusing to take a memory edit lease while the memory checkout has unsynced changes: ${formatChanges(changes)}. Sync or revert them first; never stage another session's files${existing ? ` (if they are yours from the stale lease, pass its token: --reclaim-stale --lease <token>)` : ''}.`,
      );
    }
    const adoptedCommits = validateOwnedPendingCommits(memoryRoot, agentId);

    fetchOrigin(memoryRoot);
    if (adoptedCommits > 0) {
      if (!isAncestor(memoryRoot, 'origin/main', 'HEAD')) rebaseOntoOrigin(memoryRoot);
    } else {
      git(['merge', '--ff-only', '--no-autostash', 'origin/main'], memoryRoot);
    }
    const baseline = baselineFromOrigin(memoryRoot, agentId);
    if (!baseline.tree) {
      throw new Error(`Agent folder ${agentId}/ is not published on origin/main yet. Run setup first.`);
    }
    if (holderPid) {
      // The fetch/rebase above can take a while: re-read the holder identity
      // right before the lease is written so a holder that died meanwhile
      // never gets a lease that is stale on arrival.
      const again = probeProcess(holderPid, { fresh: true });
      if (again.state !== 'alive' || again.start !== holderStart) {
        throw new Error(`Process ${holderPid} is no longer the same live process; no lease was taken.`);
      }
    }
    // A previous holder's delayed write that landed during the fetch/merge
    // must not be placed under the new token: re-check cleanliness right
    // before the lease is written.
    const lateChanges = repositoryChanges(memoryRoot);
    if (lateChanges.length > 0) {
      throw new Error(
        `Unsynced changes appeared while the lease was being taken (${formatChanges(lateChanges)}); no lease was taken. If they are yours from a released lease, retry with --lease <released token>.`,
      );
    }

    const now = new Date().toISOString();
    const lease = {
      agent: agentId,
      token: randomUUID(),
      holderPid: holderPid ?? null,
      holderStart,
      checkout: checkoutRoot,
      createdAt: now,
      renewedAt: now,
      baseline,
      commit: adoptedCommits > 0 ? revision(memoryRoot, 'HEAD') : null,
    };
    writeLease(commonGitDirectory, lease);

    if (previousOwner) {
      console.warn(`Reclaimed a stale memory edit lease (previous owner: ${previousOwner}); its token no longer works.`);
    }
    console.log(`Memory edit lease acquired for ${agentId}${holderPid ? ` (holder pid ${holderPid})` : ' (TTL-only: no --holder-pid given)'}.`);
    console.log(`Lease token: ${lease.token}`);
    console.log(`Baseline: origin/main ${baseline.commit.slice(0, 12)}, ${agentId}/ tree ${baseline.tree.slice(0, 12)}${adoptedCommits > 0 ? `; adopted ${adoptedCommits} unpublished local commit(s)` : ''}`);
    console.log(`Publish with: pnpm memory sync --agent ${agentId} --lease ${lease.token} --message "${agentId}: <summary>"`);
  } finally {
    releaseLock();
  }
}

function renewLease(memoryRoot, commonGitDirectory, agentId, token) {
  const lease = requireOwnLease(commonGitDirectory, agentId, token, 'edit --renew');
  const changes = repositoryChanges(memoryRoot);
  validateOwnedChanges(changes, agentId);

  fetchOrigin(memoryRoot);
  // The disclosure is anchored to the baseline the holder actually edited
  // against (kept as `renewedFrom` across repeated renews), so a renew whose
  // output was lost can be re-run and still lists every remote change.
  const editedAgainst = lease.renewedFrom ?? lease.baseline;
  const unpublished = validateOwnedPendingCommits(memoryRoot, agentId);
  if (unpublished > 0) {
    // A rebase needs a clean tree; sync (which commits) or revert first.
    if (changes.length > 0) {
      throw new Error(
        `edit --renew cannot rebase your unpublished commit over unsynced edits: ${formatChanges(changes)}. Sync (which commits them) or revert them first.`,
      );
    }
    if (!isAncestor(memoryRoot, 'origin/main', 'HEAD')) rebaseOntoOrigin(memoryRoot);
  } else {
    // Only working-tree edits: a fast-forward keeps them unless they overlap
    // the remote change, in which case the overlap is named for a hand merge.
    const forward = git(['merge', '--ff-only', '--no-autostash', 'origin/main'], memoryRoot, { allowFailure: true });
    if (forward.status !== 0) {
      const remoteFiles = new Set(
        git(['diff', '--name-only', 'HEAD', 'origin/main', '--', agentId], memoryRoot).stdout.split(/\r?\n/).filter(Boolean),
      );
      const overlap = changes.map((change) => change.path).filter((file) => remoteFiles.has(file));
      throw new Error(
        `Your unsynced edits overlap files changed on origin/main (${overlap.join(', ') || formatChanges(changes)}); merge them by hand (git -C <memory repository> diff HEAD origin/main -- ${agentId}), then run edit --renew again.`,
      );
    }
  }

  // The holder may have died during the fetch/rebase work: re-check with a
  // fresh probe before the lease is rewritten.
  requireOwnLease(commonGitDirectory, agentId, token, 'edit --renew', { fresh: true });
  lease.renewedFrom = editedAgainst;
  lease.baseline = baselineFromOrigin(memoryRoot, agentId);
  lease.commit = unpublished > 0 ? revision(memoryRoot, 'HEAD') : null;
  lease.renewedAt = new Date().toISOString();
  writeLease(commonGitDirectory, lease);

  const remoteChanges = git(
    ['diff', '--name-only', editedAgainst.commit, lease.baseline.commit, '--', agentId],
    memoryRoot,
    { allowFailure: true },
  ).stdout.trim();
  console.log(`Memory edit lease renewed; baseline rotated to origin/main ${lease.baseline.commit.slice(0, 12)}.`);
  console.log(
    remoteChanges
      ? `Files changed remotely since the baseline you edited against (${editedAgainst.commit.slice(0, 12)}) — re-read them before syncing:\n${remoteChanges}`
      : 'No files under your folder changed remotely.',
  );
}

function release(agentId, token, cwd) {
  const { checkoutRoot, canonicalRoot, commonGitDirectory } = discoverRoots(cwd);
  const remote = resolvedRemote(checkoutRoot, projectContext(checkoutRoot).configuredRemote);
  const memoryRoot = path.join(canonicalRoot, MEMORY_DIRECTORY);
  const releaseLock = acquireLocks(commonGitDirectory, agentId, 'release');
  try {
    requireMemoryReady(memoryRoot, agentId, remote);
    requireOwnLease(commonGitDirectory, agentId, token, 'release');
    const changes = changesUnder(repositoryChanges(memoryRoot), agentId);
    if (changes.length > 0) {
      throw new Error(
        `Refusing to release the lease while ${agentId}/ has unsynced changes (${formatChanges(changes)}); sync or revert them first so nothing is left for the next session to inherit.`,
      );
    }
    const unpublished = pendingCommitCount(memoryRoot);
    if (unpublished > 0) {
      throw new Error(
        `Refusing to release the lease while ${unpublished} local commit(s) remain unpublished; sync them first.`,
      );
    }
    if (!finalizeLease(memoryRoot, commonGitDirectory, agentId, `Release requested for ${agentId}.`)) {
      throw new Error(`Refusing to release the lease: edits arrived under ${agentId}/ meanwhile; sync or revert them first.`);
    }
  } finally {
    releaseLock();
  }
}

function sync(agentId, message, token, cwd) {
  const { checkoutRoot, canonicalRoot, commonGitDirectory } = discoverRoots(cwd);
  const { project, configuredRemote } = projectContext(checkoutRoot);
  const remote = resolvedRemote(checkoutRoot, configuredRemote);
  const memoryRoot = path.join(canonicalRoot, MEMORY_DIRECTORY);
  const releaseLock = acquireLocks(commonGitDirectory, agentId, 'sync');
  try {
    const agentRoot = requireMemoryReady(memoryRoot, agentId, remote);
    if (!token) {
      throw new Error(`sync requires --lease <token>. Run edit --agent ${agentId} first and pass the token it prints.`);
    }
    const lease = requireOwnLease(commonGitDirectory, agentId, token, 'sync');
    lease.renewedAt = new Date().toISOString();
    writeLease(commonGitDirectory, lease);

    const changes = repositoryChanges(memoryRoot);
    validateOwnedChanges(changes, agentId);
    validateMemoryTree(agentRoot);
    let knownUnpublishedCommits = validateOwnedPendingCommits(memoryRoot, agentId);

    // Generation check (a): before creating the holder's commit, the local
    // folder tree must still be what the lease started from (or the holder's
    // own earlier commit). Anything else is a same-harness commit that
    // bypassed the lease.
    const head = revision(memoryRoot, 'HEAD');
    if (lease.commit ? head !== lease.commit : folderTree(memoryRoot, head, agentId) !== lease.baseline.tree) {
      throw new Error(
        `A same-harness commit landed in the shared checkout after your lease baseline (HEAD ${head.slice(0, 12)}); re-read your files, then run edit --renew --agent ${agentId} --lease ${token} before syncing.`,
      );
    }

    if (!hasMemoryToPublish(changes, knownUnpublishedCommits)) {
      finalizeLease(memoryRoot, commonGitDirectory, agentId, `No ${agentId} memory changes to publish.`);
      return;
    }
    if (changes.length > 0) {
      git(['add', '--all', '--', agentId], memoryRoot);
      const staged = git(['diff', '--cached', '--quiet', '--', agentId], memoryRoot, {
        allowFailure: true,
      });
      if (staged.status !== 0) {
        const commitMessage = message?.trim() || `${agentId}: update ${project} memory`;
        lease.commit = commitOwnFolder(
          memoryRoot,
          agentId,
          commitMessage,
          'The commit was undone; fix the files and sync again (the lease is kept).',
          head,
        );
        writeLease(commonGitDirectory, lease);
        knownUnpublishedCommits = pendingCommitCount(memoryRoot);
      }
    }
    if (knownUnpublishedCommits > 0) {
      // Every commit that will reach origin/main is validated, not only the
      // final tree: adopted commits from a crashed session carry their own
      // intermediate trees into history.
      validatePendingCommits(memoryRoot, agentId, lease.commit);
    }
    if (knownUnpublishedCommits === 0) {
      finalizeLease(memoryRoot, commonGitDirectory, agentId, `No ${agentId} memory changes to publish.`);
      return;
    }

    // Generation check (b), after every fetch: classify the fetched tree.
    const classify = () => {
      if (lease.commit && isAncestor(memoryRoot, lease.commit, 'origin/main')) {
        // A push whose acknowledgement was lost: the holder's commit is
        // already in history, even when a later same-harness commit sits on
        // top of it (that writer's own edit had to pass the fence).
        return 'published';
      }
      const fetchedTree = folderTree(memoryRoot, 'origin/main', agentId);
      if (fetchedTree === lease.baseline.tree) return 'push';
      throw new Error(
        `A same-harness commit landed on origin/main after your lease baseline; re-read your files, then run edit --renew --agent ${agentId} --lease ${token} and sync again. Nothing was pushed and your local commit is kept.`,
      );
    };
    // The holder may have died during the fetch/rebase work above: re-check
    // with a fresh probe immediately before the push (a holder that dies
    // during the push itself cannot stop a non-cancellable transfer; that
    // publish is Git-recoverable and its lease is dropped as usual), and
    // again before the lease is dropped.
    const stillMine = () => requireOwnLease(commonGitDirectory, agentId, token, 'sync', { fresh: true });
    const outcome = publishLoop(memoryRoot, agentId, remote, {
      // Only the holder's own commit is ever rebased or pushed: a
      // same-harness commit that slipped in after the generation check is
      // refused before the rebase and before the push.
      own: () => lease.commit,
      hint: `Re-read your files, then run edit --renew --agent ${agentId} --lease ${token} and sync again.`,
      classify,
      onRebased: (rebasedHead) => {
        lease.commit = rebasedHead;
        writeLease(commonGitDirectory, lease);
      },
      beforePush: stillMine,
    });
    try {
      stillMine();
    } catch (error) {
      // The publish already happened; a holder that died during the push
      // must not leave a lease behind for a stale reclaim.
      console.warn(`${error instanceof Error ? error.message : String(error)} The publish had already completed; releasing the lease anyway.`);
    }
    // Summarize what was published, as committed: the working tree may hold
    // a late edit by now, which finalizeLease keeps the lease for, and must
    // not turn a completed publish into a reported failure.
    const summary = validateCommittedTree(memoryRoot, lease.commit, agentId);
    finalizeLease(
      memoryRoot,
      commonGitDirectory,
      agentId,
      outcome === 'published'
        ? `Your ${agentId} memory commit was already on origin/main (a previous push succeeded).`
        : `Published ${agentId} memory (${summary.files} files, ${summary.totalBytes} bytes).`,
      {
        // The lease survives for the late edits: rotate its baseline to the
        // tree that is now published, so the next sync starts from it
        // instead of refusing against the pre-publish baseline.
        onKeep: () => {
          if (!isAncestor(memoryRoot, 'origin/main', 'HEAD')) {
            const forward = git(['merge', '--ff-only', '--no-autostash', 'origin/main'], memoryRoot, { allowFailure: true });
            if (forward.status !== 0) {
              // The late edit overlaps a later remote commit: leave the lease
              // exactly as it is (its commit is published, so the next sync
              // classifies it as such again) and hand the overlap to renew,
              // which reports the overlapping files for the holder to merge.
              console.warn(
                `Could not fast-forward to origin/main over the late edits (they overlap a later remote commit); the lease baseline is unchanged. Run edit --renew --agent ${agentId} --lease ${token}, merge the files it names by hand, then sync.`,
              );
              return;
            }
          }
          lease.baseline = baselineFromOrigin(memoryRoot, agentId);
          lease.commit = null;
          delete lease.renewedFrom;
          writeLease(commonGitDirectory, lease);
        },
      },
    );
  } finally {
    releaseLock();
  }
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  leaseName = null;
  const parsed = parseArguments(argv);
  const { command, agentId, message } = parsed;
  if (command === 'setup') setup(agentId, cwd, parsed.remote);
  if (command === 'status') status(agentId, cwd);
  if (command === 'sync') sync(agentId, message, parsed.lease, cwd);
  if (command === 'edit') edit(agentId, parsed, cwd);
  if (command === 'release') release(agentId, parsed.lease, cwd);
}
