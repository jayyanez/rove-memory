# Changelog

## 1.1.0 — 2026-10-08

- The memory remote can be kept out of `package.json`: leave out
  `roveMemory.remote` and run `setup --remote <url>` once on each computer;
  it is stored in the repository's local Git configuration
  (`rove-memory.remote`) and read by every command. Two different remotes
  (package.json and the local setting) are refused.
- The edit lease is named after the memory repository (`<name>.lease`, with a
  `<name>.lock` taken after the operation lock `rove-memory.lock`), so every
  worktree shares it and an earlier copy of the tool that used those names
  excludes and is excluded. Upgrading from 1.0.0 moves the lease from
  `rove-memory.lease`: upgrade while no lease is held.

## 1.0.0 — 2026-10-08

First public release.

- `rove-memory setup | status | edit | sync | release --agent <id>`: one
  private memory repository per project, checked out as `.agent-memory/`, one
  folder per agent, written under an edit lease.
- Configuration in the project's `package.json` (`roveMemory`: `project`,
  `remote`); remotes cannot carry credentials.
- Memory goes only to the configured repository: every effective fetch and
  push URL is checked, after Git's URL rewriting, at every command and before
  each push.
- Only the agent's own folder and its own commits are published: linear,
  non-empty history; the agent's commit identified by its SHA on the `HEAD` it
  checked; a rebase must reproduce the agent's commits one for one.
- Claude Code: `setup --agent claude` points the checkout's
  `autoMemoryDirectory` at the portable memory.
