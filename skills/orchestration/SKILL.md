---
name: orchestration
description: >-
  Hand work to Orca worker agents and get their results back. Use when asked to
  change code in a project (the worker gets a new workspace of that project),
  to split work across parallel agents, to run work on a different agent or
  model, or to run long work in the background; also when you are a dispatched
  worker (a prompt with Task and Dispatch IDs: heartbeats, ask, worker_done).
  Covers task DAGs, ask/reply, and decision gates. Not for questions or small
  edits in your own checkout. Use `orca-cli` instead to give work away for good
  with no result expected back ("hand off", "handover", "give this to another
  agent"), and for terminal control, shell commands, worktree management, and
  reading or waiting on terminals.
---

# Orca Orchestration

This file is a discovery stub, not the usage guide. The full, version-matched Orca
orchestration reference is served by the `orca` binary itself — kept out of this file on
purpose so it can never drift from the binary that will actually run your commands.

Use Orca orchestration to hand work to Orca worker agents and get their results back:
a code change in a project (the worker gets a new workspace of that project), work split
across parallel agents, work for a different agent or model, or long background work. Use
it as well when you are a dispatched worker sending heartbeats, `ask` questions, or
`worker_done`. Do questions and small edits in your own checkout yourself. Use the orca-cli
skill instead to give work away for good with no result expected back ("hand off",
"handover", "give this to another agent"), and for ordinary terminal control, shell
commands, worktree management, and the built-in browser. Coordination requires real Orca
runtime state; never substitute a non-Orca subagent tool.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- Otherwise, on Linux outside an Orca-managed terminal, use `orca-ide`. Never run bare
  `orca` there — outside Orca's terminals it normally resolves to the
  GNOME Orca screen reader (`/usr/bin/orca`) and starts speech on the user's machine.
- Otherwise, use `orca`.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build.

## Load the version-matched guide before running Orca commands

```text
ORCA skills get orchestration
```

That prints the compact, version-matched guide for the exact binary that will handle your
next commands. It covers when to hand off, the normal coordinator recipe, and dispatched-worker
obligations. For a conditional action gate such as remote placement, uncertain release
recovery, or expanded DAG work, load only the reference that gate names with
`ORCA skills get orchestration --reference references/<file>.md`
(`--references` lists the names). If that binary rejects `--reference`, run
`ORCA skills get orchestration --full` and read the named bundled reference before acting.

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Orca is not running, start it with `ORCA open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `ORCA open` or restart Orca. If
`skills get` is unknown, explain that updating Orca restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
