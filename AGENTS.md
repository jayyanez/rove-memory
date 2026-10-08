# Agent guide

Rove Memory is a standalone Node.js command that keeps coding agents'
portable memory for a project in that project's own private Git repository.
Read [README.md](README.md) for the product, [POLICY.md](POLICY.md) for the
policy adopting projects' agents follow, and [CONTRIBUTING.md](CONTRIBUTING.md)
for the contributor workflow.

This is the shared instruction file for coding agents working on this
repository; `CLAUDE.md` only imports it. Keep common guidance here. All
repository and GitHub artifacts are in English.

## Before changing anything

- Inspect the current branch and the full working-tree status; preserve other
  work. Fetch `origin` and base new work on current `origin/main`, on a branch;
  never push to `main` (the pre-push hook refuses it).
- Read the README sections on safety and the edit lease before changing
  `rove-memory.mjs`: they are the contract adopting projects rely on.

## The rules of the tool

- **Memory stays private.** It goes only to the remote the project
  configured; a remote from the environment is honoured only as a local
  absolute path (the tests' bare repositories), and a checkout whose
  effective fetch or push URLs are anything else is refused.
- **One agent, one folder.** Never stage, commit, discard or reset another
  agent's files or the memory repository's shared `README.md`; refuse and
  name them.
- **The lease decides who publishes.** Only the live holder's token
  publishes; liveness fails toward keeping a live holder; a commit of the same
  agent after the baseline refuses the sync; what is pushed is the exact
  validated commit, and a rebase must reproduce the agent's commits one for
  one.
- **Node.js built-ins only** at runtime, on Windows, macOS and Linux.
- **Compatibility.** The `roveMemory` configuration (and the local
  `rove-memory.remote` setting), the command line, the `.agent-memory/`
  folder and the lock and lease files are what adopting
  projects rely on: change them only together with `README.md`, `POLICY.md`,
  `CHANGELOG.md` and a version bump.

## Verification

```text
pnpm install --frozen-lockfile
pnpm test
```

The suites drive the real command against real Git in temporary
repositories. Every behaviour change carries a test, and every bug fix a
regression test that fails before the fix. Race conditions are reproduced with
Git hooks in the fixture repositories (see `test/hardening.test.mjs`).

## Review

Maintainers review the committed branch with
[Rove Sentinel](https://github.com/jayyanez/rove-sentinel) before pushing:

```text
pnpm review:gate -- --base origin/main --head HEAD --detach
```

Read the printed log until `[review-gate] exit <code>`, resolve or defensibly
dismiss every verified finding, and push only the head that passed. The
charter (`docs/review/charter.md`), the lessons and this file are review
policy. Contributors without Sentinel say so in their pull request, and a
maintainer completes the review.
