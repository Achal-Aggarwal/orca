import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import { reconcileRequestedWorkerTerminalReleases } from './worker-terminal-release-reconciliation'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import { WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS } from './db/worker-terminal/worker-terminal-auto-release'
import { exposeUtcTimestamp } from './db/utc-timestamp'

const MAX_TIMER_DELAY_MS = 2_147_483_647

const schedulerByRuntime = new WeakMap<
  WorkerTerminalReleaseRuntime,
  WorkerTerminalAutoReleaseScheduler
>()

// Keyed by runtime, not a field: the database can open while the runtime is still constructing.
export function getWorkerTerminalAutoReleaseScheduler(
  runtime: WorkerTerminalReleaseRuntime
): WorkerTerminalAutoReleaseScheduler {
  let scheduler = schedulerByRuntime.get(runtime)
  if (!scheduler) {
    scheduler = new WorkerTerminalAutoReleaseScheduler(runtime)
    schedulerByRuntime.set(runtime, scheduler)
  }
  return scheduler
}

/** One timer for the nearest settled-worker deadline; claimed rows finish through release recovery. */
export class WorkerTerminalAutoReleaseScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDeadlineMs: number | undefined

  constructor(private readonly runtime: WorkerTerminalReleaseRuntime) {}

  rearm(): void {
    const next = this.runtime.getOrchestrationDb().nextWorkerTerminalAutoReleaseAtMs()
    if (this.timer && this.timerDeadlineMs === next) {
      return
    }
    this.clear()
    if (next === null) {
      return
    }
    const timer = setTimeout(
      () => {
        if (this.timer !== timer) {
          return
        }
        this.timer = undefined
        this.timerDeadlineMs = undefined
        void this.releaseDue()
      },
      Math.min(Math.max(0, next - Date.now()), MAX_TIMER_DELAY_MS)
    )
    timer.unref?.()
    this.timer = timer
    this.timerDeadlineMs = next
  }

  async releaseDue(): Promise<void> {
    try {
      const claimed = this.runtime
        .getOrchestrationDb()
        .claimDueWorkerTerminalAutoReleases(Date.now())
      if (claimed > 0) {
        await reconcileRequestedWorkerTerminalReleases(this.runtime)
      }
    } catch (error) {
      // Claimed rows stay requested, so release recovery retries them after the next inventory.
      warnAutoReleaseFailure(error)
    }
    try {
      this.rearm()
    } catch (error) {
      warnAutoReleaseFailure(error)
    }
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = undefined
    this.timerDeadlineMs = undefined
  }
}

function warnAutoReleaseFailure(error: unknown): void {
  console.warn('[orchestration] worker terminal auto-release failed', {
    error: error instanceof Error ? error.message : String(error)
  })
}

/** An automatic close yields to anyone who typed after worker_done, even if their takeover report never arrived.
 *  Checked just before the close; on refusal the terminal becomes the user's, exactly as a takeover makes it. */
export function yieldAutoReleaseToUserInput(
  runtime: WorkerTerminalReleaseRuntime,
  resource: WorkerTerminalResourceRow,
  terminalHandle: string
): WorkerTerminalResourceRow {
  const armed =
    resource.auto_release_at && resource.auto_release_dispatch_id === resource.owner_dispatch_id
      ? Date.parse(exposeUtcTimestamp(resource.auto_release_at) ?? '') -
        WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS
      : null
  const typedAt = armed === null ? null : runtime.getTerminalLastDrivingInputAt(terminalHandle)
  if (armed === null || typedAt === null || !(typedAt > armed)) {
    return resource
  }
  const db = runtime.getOrchestrationDb()
  db.revertWorkerTerminalReleaseToRetained(resource.id, 'user_takeover')
  if (resource.pane_key) {
    db.markWorkerTerminalUserOwned(resource.pane_key)
  }
  return db.getWorkerTerminalResource(resource.id) ?? resource
}
