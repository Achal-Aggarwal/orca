---
name: orchestration
description: >-
  Coordinate supervised Orca workers, or work as a dispatched worker
  (heartbeats, ask, worker_done): threaded messages, blocking ask/reply, task
  dispatch, worker_done/escalation waits, task DAGs, decision gates,
  coordinator loops, and decomposing work across agents. Use `orca-cli` for full
  ownership handoffs — "hand off", "handoff", "handover", "give this to another
  agent", "another worktree" — unless asked to supervise, monitor, or coordinate
  a DAG, and for terminal control, lightweight terminal prompts, shell commands,
  Orca worktree management, and reading or waiting on terminals.
---

# Orca orchestration

You (the coordinator) start worker agents through Orca, end your turn, and Orca
wakes you when a worker reports back. Terms:

- **Run**: your inbox for one goal. Workers report to it.
- **Task**: one piece of work. **Dispatch**: one attempt at a Task by one worker.
- **Settled**: the worker sent `worker_done` (succeeded or failed).

## Your role

| Situation                                                                                                             | Role              | What to do                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| The user asks you to supervise or monitor workers, wait for their results, coordinate a task DAG, or manage ask/reply | Coordinator       | Follow the main recipe below                                              |
| Your prompt has a live preamble with Task and Dispatch IDs                                                            | Dispatched worker | Follow the preamble and "If you are a dispatched worker" below            |
| The user asks to hand work off or start another agent or worktree, without supervising it                             | Handoff owner     | Use the `orca-cli` skill; create no Run, Task, or Dispatch                |
| A message carries a legacy authority label                                                                            | Compatibility     | Load `references/legacy-contract-migration.md` before changing any state  |
| None of the above                                                                                                     | Ordinary agent    | Send no lifecycle messages; use `orca-cli` for terminal and worktree work |

Choosing a model or effort does not make a handoff supervised: `orca-cli`'s
`worktree create --agent` and `agent launch` take `--model` and `--effort` too.

## Main recipe

`ORCA` below stands for the executable you used to run `skills get`. Type that
executable in its place; do not create a shell variable or run `ORCA`
literally. If it fails, report its exact error; never switch to another one.

```text
ORCA orchestration run-create --objective "<goal>" --json
ORCA orchestration worker-start --spec "<task>" --worktree current --agent claude --json
```

- `--worktree current` runs the worker in your workspace; an exact workspace
  selector runs it in another existing one. Placement goes on `worker-start`;
  `run-create` takes none.
- Create a new workspace only when the user asks for one, or sharing a checkout
  would conflict (for example, the change belongs to a project you are not
  in). Pass the project with `--repo`; `ORCA repo list --json` gives its id.
  Without `--repo`, Orca uses the Git project you are in, and fails if you are
  in none:
  `ORCA orchestration worker-start --spec "<task>" --worktree new-top-level --repo id:<repoId> --name <short-name> --agent claude --json`
- `--agent` is the agent the user asked for, otherwise the kind you are. Add
  `--model` only when the user named one.
- Start every independent worker before you stop. One `worker-start --spec`
  call creates the Task and its Dispatch.
- If `worker-start` exits non-zero, do not run it again. Read `failedStage`
  and `residualResources` in its output, then load
  `references/recovery-and-cleanup.md`.

Then tell the user what you started and **end your turn**. Do not wait or poll.

## When Orca wakes you

When a worker reports, Orca sends you a new message: "You have N orchestration
messages. Run `orca orchestration check --run <run_id>`." In a terminal it is
typed in for you; in a chat it arrives as a user message. Run that command and
handle every message it returns:

```text
ORCA orchestration check --run <run_id> --json
ORCA orchestration reply --id <message_id> --body "<answer>" --json
ORCA orchestration worker-release --dispatch <dispatch_id> --json
ORCA orchestration check --run <run_id> --ack <delivery_id> --json
```

- Answer each `question` with `reply`. Check each `worker_done` against the
  Dispatch you expect, then decide its worker's next owner (see Completion).
- `--ack` marks the batch handled and returns the next one. Repeat until
  `count` is 0. A batch you do not ack is returned again and hides newer mail.
- Tell the user the result, or end your turn again while workers are still
  running. A worker that has not reported is still working; a quiet inbox is
  not a failure.

**Waiting inside one turn.** Only when the user needs the result before your
turn ends, or you run outside an Orca terminal or chat (nothing can wake you),
block instead, with a timeout under 10 minutes:

```text
ORCA orchestration check --run <run_id> --wait --types "worker_done,escalation,question" --timeout-ms 540000 --json
```

A timeout is a checkpoint, not a failure: wait again or end the turn. After
three empty waits in a row, inspect the workers with
`references/recovery-and-cleanup.md`. After a restart, resume your Run with
`ORCA orchestration run-use --id <run_id> --json`.

## Task spec

The worker sees only its spec. Make each one self-contained:

- **Target:** the files, component, or environment in scope.
- **Change:** the concrete result to produce.
- **Constraints:** rules to keep, and what not to touch.
- **Ownership:** what this worker may edit.
- **Acceptance:** the test, output, or evidence that proves it is done.

## Completion

A valid `worker_done` settles its Task; do not follow it with `task-update`.
For each settled worker, before you ack, do exactly one:

1. Give the same worker an immediate follow-up
   (`references/coordinator-loop.md`).
2. Keep it because the user asked, with `worker-retain`.
3. Free it with `worker-release`.

Release is cleanup after settlement, never cancellation. You are done when
`ORCA orchestration worker-list --run <run_id> --terminal-state reclaimable --json`
returns nothing and you have told the user, per Task, the outcome, its
evidence, and any open blocker.

## Safety floor

- Stop, abandon, or retry a worker only on positive proof that its agent
  exited. Release it only after it settled. Silence, a timeout, or an
  `unverifiable` reading proves nothing: keep waiting or inspect.
- Liveness verdicts are `live`, `unverifiable`, or `exited`. Losing contact
  with a remote host is `unverifiable`, not death.
- Folder workspaces are valid workspaces; never require Git there.
- Use one executable for the whole Run.
- A successful `send` means the message is stored, not that it was read.
- Never replace Orca workers with another subagent tool when the user asked
  for Orca orchestration.

## If you are a dispatched worker

Your prompt (the preamble) carries your Task ID, Dispatch ID, and exact
commands. It is authoritative: copy its commands and flags, never rebuild them.

1. Do only your Task. For a question the coordinator must answer, use the
   preamble's `ask` command, never a local prompt. After an `ask` timeout,
   resume the same message ID.
2. Send heartbeats only at the preamble's cadence. Stop any heartbeat loop
   before `worker_done`.
3. At natural checkpoints and right before `worker_done`, read coordinator
   mail with `ORCA orchestration check --terminal <your_handle> --json`, then
   ack each batch with `--ack <delivery_id>` until `count` is 0.
4. Send `worker_done` exactly once, from your own terminal or chat: three
   sentences (what changed, what you found, what remains), both IDs, and
   `--outcome succeeded` or `--outcome failed`. Add `--files-modified` and
   `--report-path` only with real values.
5. Then end your turn and idle. A later direct user instruction is new work;
   do not reuse the settled IDs.

## References

Load a reference only when its situation applies:
`ORCA skills get orchestration --reference references/<file>.md`
(`--references` lists them). If the CLI rejects `--reference`, run
`ORCA skills get orchestration --full` once and read only the named section.
If it rejects `--full` too, use `--help` and never guess newer flags.

| Situation                                                                                           | Reference                                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Task DAGs and dependencies, model/effort, reusing a settled worker, review-only work                | `references/coordinator-loop.md`          |
| You are a worker and the preamble does not answer your question, or `check` errored                 | `references/worker-contract.md`           |
| Child or exact workspaces, folder workspaces, SSH, WSL, or a connected Orca server                  | `references/placement-and-remote.md`      |
| Batch replay, follow-ups to one worker, group addresses, or decision gates                          | `references/messaging-and-gates.md`       |
| A failed, stopped, silent, or unknown worker; retry, stop, abandon, retain, or an uncertain release | `references/recovery-and-cleanup.md`      |
| Custom argv or terminal layout that `worker-start` cannot express                                   | `references/low-level-topology.md`        |
| A legacy label, adopted Run, compatibility receipt, or takeover                                     | `references/legacy-contract-migration.md` |
