# Rove Memory

Portable memory for coding agents. Claude Code, Codex and other agents learn
things about a project while they work on it — your preferences, lessons from
past mistakes, where a task was left. By default that memory stays on one
computer. Rove Memory keeps it in a **private Git repository of the project's
own**, checked out as the ignored `.agent-memory/` folder, so the same memory
follows you to every computer you work from.

- **One private repository per project**, one folder per agent (`claude/`,
  `codex/`, …). Each agent writes only its own folder.
- **An edit lease** so two sessions on the same machine — or two machines —
  never overwrite each other's memory, and a write that would publish someone
  else's change is refused.
- **Markdown only, bounded**: a short `MEMORY.md` index plus topic files, with
  size limits, validated before anything is pushed.
- **No service, no model calls, no runtime dependencies**: a Node.js command
  that drives Git.

It is not a vector store or a retrieval system for LLM applications. It is
the durable notebook your coding agents keep about a project, versioned like
the project itself.

## Requirements

- Node.js 22 or later and Git.
- A package manager to install it (pnpm is used in the examples).
- For each project, an empty **private** Git repository for its memory, and
  Git credentials on each computer that can read and push it.

## Adopting it in a project

1. Create the project's memory repository, for example
   `gh repo create <owner>/<project>-agent-memory --private`, with a
   `README.md` on `main` that says what it is and that each agent owns only
   its folder (`setup` creates the folders).
2. In the project's `package.json`, add the tool pinned to a commit, a script
   for it, and the configuration:

   ```json
   {
     "scripts": { "memory": "rove-memory" },
     "devDependencies": {
       "rove-memory": "github:jayyanez/rove-memory#<commit>"
     },
     "roveMemory": {
       "project": "<Project>",
       "remote": "https://github.com/<owner>/<project>-agent-memory.git"
     }
   }
   ```

   The remote must be a plain HTTPS or SSH Git URL: credentials, query strings
   and fragments are refused, so the configuration can be committed safely.
3. Add `.agent-memory/` to the project's `.gitignore`.
4. Tell your agents to use it: add a section like the one below to the
   project's `CLAUDE.md` / `AGENTS.md`.
5. Run `pnpm install`, then `pnpm memory setup --agent claude` (or
   `--agent codex`, …).

To move a project to a newer version, change the pinned commit.

### Keeping the memory's address out of a public project

A public project may not want to publish the address of its private memory
repository. Leave `remote` out of `roveMemory` and give it once on each
computer instead:

```text
pnpm memory setup --agent claude --remote https://github.com/<owner>/<project>-agent-memory.git
```

`setup` keeps it in the repository's local Git configuration
(`git config --local rove-memory.remote`), which every linked worktree shares
and which is never committed; every later command reads it from there. A
different value is never overwritten silently, and package.json and the local
setting may both be present only when they name the same repository.

### Sharing the lock and lease with another tool

The lock and lease are `<stateName>.lock` and `<stateName>.lease` in the
project's Git directory, with `stateName` defaulting to `rove-memory`. A
project moving from an earlier copy of this tool can set
`"stateName": "<the old name>"` in `roveMemory`, so that sessions still
running the old copy and sessions running Rove Memory exclude each other
while both are in use. The lease format is the same.

### A section for the project's agent files

```markdown
## Portable memory

Agents' memory for this project lives in the private
`<owner>/<project>-agent-memory` repository, checked out as the ignored
`.agent-memory/` folder in the canonical checkout. Each agent uses one stable
lowercase id (`claude`, `codex`, …) and owns only `.agent-memory/<id>/`. The
policy is `node_modules/rove-memory/POLICY.md`; read it before the first
memory write of a session.

- Session start, in every checkout and linked worktree: `pnpm install`, then
  `pnpm memory setup --agent <id>`, then read `MEMORY.md` in the agent folder
  it prints. If setup fails, stop and report it.
- Every write is a lease: `pnpm memory edit --agent <id>` prints a token;
  write; `pnpm memory sync --agent <id> --lease <token> --message "<id>: …"`
  publishes and releases it. Never end a turn holding a lease.
- Never touch another agent's folder. Memory is advisory: Git, the code and
  the project's documents override it. Store only durable context — never
  secrets, transcripts, logs or machine-local paths.
```

## Commands

From any checkout or linked worktree of the project:

| Command | What it does |
|---|---|
| `pnpm memory setup --agent <id> [--remote <url>]` | Clone or fast-forward `.agent-memory/`, create and publish `<id>/` when it is missing; for `claude`, point this checkout's `autoMemoryDirectory` at it. `--remote` stores the memory remote in the repository's local Git configuration. |
| `pnpm memory status --agent <id>` | Project, memory remote, folder bounds, unsynced changes, unpublished commits, the edit lease, and Claude Code's configuration. |
| `pnpm memory edit --agent <id> [--holder-pid <pid>]` | Take the edit lease and print its token. `--renew --lease <token>` after a commit of the same agent landed; `--reclaim-stale` for a lease whose holder is gone. |
| `pnpm memory sync --agent <id> --lease <token> [--message <text>]` | Validate, commit, rebase, push, and release the lease. |
| `pnpm memory release --agent <id> --lease <token>` | Give back a lease with nothing to publish. |

A leading `--` (as some package managers pass it) is ignored. The memory
checkout lives in the project's canonical checkout (found through Git's common
directory), so every linked worktree shares it.

### Claude Code

Claude Code loads its memory from `autoMemoryDirectory`, a per-checkout
setting. `setup --agent claude` writes it into the checkout's ignored
`.claude/settings.local.json`, pointing at `.agent-memory/claude`, so a
session opened in that checkout loads the portable memory. Run `setup` once in
each new checkout or worktree.

If Claude Code already kept memory for the project in its per-machine folder
(`~/.claude/projects/<project path>/memory/`), import the durable facts that
are missing into `.agent-memory/claude/` once, publish them under a lease, and
rename the old folder so it cannot load again.

### Other agents

Agents without a memory-directory setting read
`.agent-memory/<id>/MEMORY.md` at the start of a session, as their
instructions say, and write through the same lease.

## How memory stays safe

- **Only to the configured repository.** Every URL the memory checkout would
  fetch from or push to, after Git's `insteadOf` / `pushInsteadOf` rewriting,
  must be the configured remote — the same scheme, account, host (without
  case) and path (with case); HTTPS and SSH name the same repository only on
  github.com, which documents it. This is checked at every command and again
  right before each push. A remote from the environment is honoured only as a
  local path (the test suites' bare repositories).
- **Only your folder, only your commits.** A change outside the agent's
  folder is refused and named, never staged or discarded. Memory history is
  linear and every commit changes something. The commit published is the one
  the agent made, on the `HEAD` it checked, identified by its SHA. If a rebase
  is needed, every one of the agent's commits is replayed and the result must
  match them one for one before it is adopted.
- **Validated as committed.** Every commit that will be pushed is checked as
  committed: Markdown only, no NUL bytes, no symlinks or control characters in
  paths, `MEMORY.md` within 200 lines and 25 KiB, a topic file within
  256 KiB, a folder within 2 MiB.

### The edit lease

Commands that change the memory checkout or the lease hold one operation lock
(`rove-memory.lock`, or `<stateName>.lock`, in the project's Git directory), so linked worktrees never
change the checkout at the same time. File writes cannot be locked, which is
what the lease (`rove-memory.lease` or `<stateName>.lease`, same directory)
is for:

- A lease with a holder pid is live while that process exists with the same
  start time, and stale once it is gone; a probe that cannot read the start
  time never dispossesses a holder. A lease without a holder pid is live for
  30 minutes after the last command that carried its token (the environment
  variable `ROVE_MEMORY_LEASE_TTL_MS` changes that span; the tests use it).
- Only the live holder's token can sync or release; a stale token authorizes
  nothing, and its holder re-takes its own lease with
  `edit --reclaim-stale --lease <token>`, which keeps its unsynced edits.
- Sync refuses when a commit of the same agent landed after the lease's
  baseline, locally or on the remote, and keeps the holder's commit;
  `edit --renew` rebases it and names the files that changed remotely.
- An edit that arrives while sync publishes keeps the lease instead of being
  abandoned; a write that lands after a release can be adopted only with the
  released token.
- A first bootstrap whose push failed is published by the next `setup`,
  unless another machine published the folder meanwhile: then its commits
  stay local, and `edit` adopts them under a lease for `sync` to publish.

The operation lock is a file a crashed command can leave behind; the error
names its recorded owner, and it may be removed by hand only after confirming
that process is gone.

[`POLICY.md`](POLICY.md) is the policy for the agents themselves: what
belongs in memory, ownership, and the lease routine.

## Platforms

Windows, macOS and Linux. The holder probe uses Windows PowerShell on Windows
and `ps` elsewhere. Continuous integration runs the suite on all three.

## Development

```text
pnpm install --frozen-lockfile
pnpm test
```

The suites drive the real command against real Git with temporary bare
repositories; they need no network and no accounts. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Born in Rove

Rove Memory grew out of the agent workflow of **Rove**, an upcoming desktop
application, where several coding agents share one machine and one project.
Like [Rove Sentinel](https://github.com/jayyanez/rove-sentinel), it is an
independent project that makes that piece available to anyone. Rove has not
been publicly released.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE). This license does not cover the
Rove application or any agent or service the tool works with.
