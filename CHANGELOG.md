# Changelog

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
