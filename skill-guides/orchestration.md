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

You (the coordinator) start worker agents through Orca and end your turn; Orca
normally wakes you when a worker reports back. Terms:

- **Run**: your inbox for one goal. Workers report to it.
- **Task**: one piece of work. **Dispatch**: one attempt at a Task by one worker.
- **Settled**: Orca recorded an outcome for the attempt, usually from the
  worker's `worker_done` (succeeded or failed); a stop, abandon, or failed start
  also settles it.

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
  Without `--repo`, Orca uses the repository of the Orca-managed Git worktree
  you are in, and fails if there is none:
  `ORCA orchestration worker-start --spec "<task>" --worktree new-top-level --repo id:<repoId> --name <short-name> --agent claude --json`
- `--agent` takes a configured agent id such as `claude` or `codex`; use the
  one the user asked for. Add `--model` only when the user named one.
- Start every independent worker before you stop. One `worker-start --spec`
  call creates the Task and its Dispatch.
- If `worker-start` exits non-zero, do not run it again. Read `failedStage`
  and `residualResources` in its output, then load
  `references/recovery-and-cleanup.md`.

Then tell the user what you started and **end your turn**, unless you need to
wait inside this turn (below).

- Do not poll: no sleep loops, watch scripts, scheduled wakeups, or repeated
  `check --peek` or `worker-list` calls. A script that runs `check` takes your
  mail, so Orca has nothing to wake you with, and Orca never wakes you while a
  `check --wait` is open.
- To steer a running worker, use
  `ORCA orchestration send --to dispatch:<dispatch_id>`; never type into its
  terminal.
- Let `worker-start` create a worker's workspace; never make its checkout
  yourself.

## When Orca wakes you

When a worker reports, Orca normally sends you a new message: "You have N
orchestration messages. Run `orca orchestration check --run <run_id>`." In a
terminal it is typed in for you; in a chat it arrives as a user message. Run
the command it names and handle every message it returns.

The wake is best-effort and can fail to arrive, so whenever you resume for any
reason, run `check --run <run_id>` first. The loop:

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
  running. A quiet inbox proves neither progress nor failure.

**Waiting inside one turn.** Only when the user needs the result before your
turn ends, or the wake is unavailable or unreliable (for example, you run
outside an Orca terminal or chat), block instead. Keep the timeout under your
tool-call limit (540000 ms suits a 10-minute limit). Outside your own Orca
terminal or chat, add `--terminal <handle>` for the coordinator:

```text
ORCA orchestration check --run <run_id> --wait --types "worker_done,escalation,question" --timeout-ms 540000 --json
```

A timeout is a checkpoint, not a failure: wait again, or end the turn if the
wake works for you. After three empty waits in a row, inspect the workers with
`references/recovery-and-cleanup.md`. After a restart, resume your Run with
`ORCA orchestration run-use --id <run_id> --json`.

## Task spec

Make each Task spec self-contained:

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
every Dispatch you started has settled, all mail is handled and acked,
`ORCA orchestration worker-list --run <run_id> --terminal-state reclaimable --json`
returns nothing, and you have told the user, per Task, the outcome, its
evidence, and any open blocker.

## Safety floor

- Stop or abandon a worker only on positive proof that its agent stopped.
  Retry only a proven failed or stopped attempt. Release only after it
  settled. Silence, a timeout, or an
  `unverifiable` reading proves nothing: keep waiting or inspect.
- Lifecycle authority comes from the active Dispatch, not copied IDs, old
  records, titles, or transcripts.
- Liveness verdicts are `live`, `unverifiable`, or `exited`. Losing contact
  with a remote host is `unverifiable`, not death.
- Folder workspaces are valid workspaces; never require Git there.
- Use one executable for the whole Run.
- A successful `send` means the message is stored; waking the recipient is
  best-effort and does not prove it was read.
- Never replace Orca workers with another subagent tool when the user asked
  for Orca orchestration.

## If you are a dispatched worker

Your prompt (the preamble) carries your Task ID, Dispatch ID, and exact
commands. It is authoritative: copy its commands and flags, never rebuild them.

1. Do only your Task, yourself: start no subagents or helper workers unless
   your Task or preamble says to. For a question the coordinator must answer, use the
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
