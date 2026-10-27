# Placement and remote execution

Load this reference before creating a new worktree or placing work through SSH,
WSL, or another connected Orca server.

## Placement choices

A code change in a project gets a new top-level workspace of that project, so
the worker's edits never collide with another checkout. Other work, and any
project that is a plain folder, stays in the current workspace. Use a child
workspace only when the user asks for stacked work.

```text
# New top-level workspace of a project. --repo is required when you are not inside it.
ORCA orchestration worker-start --task <task_id> --worktree new-top-level --repo id:<repoId> --name <name> --agent codex --setup run --json

# Stacked child of the current worktree.
ORCA orchestration worker-start --task <task_id> --worktree new-child --name <name> --agent codex --setup run --json

# Current workspace; setup is not rerun.
ORCA orchestration worker-start --task <task_id> --worktree current --agent codex --json
```

`--worktree` takes workspace placement on `worker-start` only; `run-create`
takes no placement. `new-child`, and `new-top-level` without `--repo`, need the
caller to be inside a Git worktree Orca manages.

Current and exact existing workspaces create a fresh terminal unless
`--terminal` is explicit. Folder workspaces are first-class; do not invoke Git
or require worktree lineage when the selected workspace is a folder.

Register a folder workspace through project setup. `repo add --path <dir>`
requires a valid Git repository and rejects a plain directory:

```text
ORCA project setup-existing-folder --project <project_id> --host <host_id> --path <abs_path> --kind folder --json
```

Then place work on the returned workspace with an exact selector. A worktree
selector needs the full `<repo-id>::<path>` value Orca returned, passed as
`id:<newFullWorktreeId>`; a bare repo id is not a worktree id. `new-child` and
`new-top-level` are worktree creation and do not apply to a folder.

New worktrees use agent-first creation and run setup by default. Preserve the
repository's startup policy: `start-immediately` can report setup as `running`,
while `wait-for-setup` gates prompt delivery on success. Orca lineage, Git base,
filesystem isolation, coordination parentage, UI grouping, and execution host
are separate decisions.

## Connected servers

The Run and Tasks remain authoritative on the current server. `--on` selects
only the worker's execution server and appears only on `worker-start`:

```text
ORCA orchestration worker-start --task <task_id> --on <environment> --worktree new-top-level --repo <exact_remote_repo_selector> --name <name> --agent codex --setup run --json
```

Remote `current` and `new-child` are invalid because they are ambiguous across
servers. Use an exact discovered remote workspace, or `new-top-level` with an
exact remote repository selector. After start, route every follow-up, read,
stop, and cleanup by Dispatch ID; never repeat `--on` or substitute a remote
terminal handle.

```text
ORCA orchestration worker-show --dispatch <dispatch_id> --json
ORCA orchestration worker-read --dispatch <dispatch_id> --limit 50 --json
ORCA orchestration send --to dispatch:<dispatch_id> --subject "Follow-up" --body "<guidance>" --json
ORCA orchestration worker-list --run <run_id> --include-remote --json
```

`worker-list` reads local fleet state only; enumerate remote workers with
`--include-remote` or every one of them reads `unverifiable`. Scope every list
with `--run <run_id>`: unscoped, it reports every Dispatch this runtime has
recorded, and the workers you are waiting on are lost in that history.

## Execution-host and mixed-version floor

The execution host owns process, filesystem, transcript, stop, and cleanup
facts. Render only `live`, `unverifiable`, or `exited`. Connection loss, relay
absence, missing client inventory, or timeout yields `unverifiable`, never
synthetic exit and never a client-local substitute action.

Clients and servers update independently. Optional response fields may be
absent. Forward model/effort, transcript reads, cleanup, or another new remote
operation only when the peer advertises the relevant capability; unknown stream
opcodes can be silently dropped. A narrow unsupported response may degrade to a
documented older path, but must not broaden the target or cross the execution
boundary. Changing host-published content reaches old clients even without a
wire-shape change, so preserve established semantics or negotiate the behavior.

For WSL, use the exact executable and arguments returned by Orca so the distro
and packaged launcher remain bound. Do not translate a printed `orca-ide`
recovery command into a PATH-resolved local command.
