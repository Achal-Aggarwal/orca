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

<!-- shared: resolver -->

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

<!-- shared: no-guessing -->
