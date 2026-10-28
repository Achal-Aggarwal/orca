import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import { WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS } from './db/worker-terminal/worker-terminal-auto-release'
import { exposeUtcTimestamp } from './db/utc-timestamp'

/** An automatic close yields to anyone who typed after worker_done, even if their takeover report never arrived.
 *  Checked just before the close; on refusal the terminal becomes the user's, exactly as a takeover makes it. */
export function yieldAutoReleaseToUserInput(
  runtime: WorkerTerminalReleaseRuntime,
  resource: WorkerTerminalResourceRow,
  terminalHandle: string
): WorkerTerminalResourceRow {
  if (
    !resource.auto_release_at ||
    resource.auto_release_dispatch_id !== resource.owner_dispatch_id
  ) {
    return resource
  }
  const settledAt =
    Date.parse(exposeUtcTimestamp(resource.auto_release_at) ?? '') -
    WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS
  const typedAt = runtime.getTerminalLastDrivingInputAt(terminalHandle)
  if (typedAt === null || typedAt <= settledAt) {
    return resource
  }
  const db = runtime.getOrchestrationDb()
  db.revertWorkerTerminalReleaseToRetained(resource.id, 'user_takeover')
  if (resource.pane_key) {
    db.markWorkerTerminalUserOwned(resource.pane_key)
  }
  return db.getWorkerTerminalResource(resource.id) ?? resource
}
