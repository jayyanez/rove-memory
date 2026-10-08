# Contributing to Rove Memory

Thanks for helping. Small reproductions, clearer messages, platform
verification and regression tests are as valuable as new features.

Coding agents should also read [AGENTS.md](AGENTS.md), the shared instruction
file.

## Run the project

Use Node.js 22 or later, Git and pnpm:

```text
pnpm install --frozen-lockfile
pnpm test
```

The suites need no network and no accounts: they create temporary
repositories, including bare "remotes", and drive the real command against
them.

## Changes

- Work on a branch and open a pull request against `main`.
- A bug fix comes with a regression test that fails before the fix. For a new
  capability, describe the intended behaviour in an issue or a draft pull
  request first.
- The configuration, the command line, the `.agent-memory/` folder and the
  lock and lease files are a contract with adopting projects. A change to any
  of them updates `README.md`, `POLICY.md` and `CHANGELOG.md` and bumps the
  version.
- No runtime dependencies: the tool uses Node.js built-ins only.
- Say in the pull request what you tested, on which platform, and what you did
  not.

## Where to help

- Run the suites on macOS and Linux setups the continuous integration does not
  cover, and report what differs.
- Clearer refusal messages: every refusal should say what to do next.
- A crash-safe operation lock that the operating system releases with its
  process, on every platform.

## Security

Do not report vulnerabilities in public issues; see [SECURITY.md](SECURITY.md).
