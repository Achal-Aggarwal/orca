const REOPEN_LOG_INTERVAL_MS = 10 * 60_000
const MAX_REOPEN_BACKOFF_MS = 60_000

/** Counts idle-writer reopens and spaces out retries after a failed one, so saving never wedges. */
export class ProfileStateWriterReopenPolicy {
  private reopens = 0
  private lastLogMs: number | undefined
  private failure: { error: unknown; failures: number; retryAtMs: number } | undefined

  constructor(private readonly now: () => number = Date.now) {}

  get count(): number {
    return this.reopens
  }

  /** Throws the last failure while its backoff lasts; nothing is spawned meanwhile. */
  admit(): void {
    if (this.failure && this.now() < this.failure.retryAtMs) {
      throw this.failure.error
    }
  }

  /** Writes just over the idle window apart churn the thread; one line per window keeps that visible. */
  recordAttempt(): void {
    this.reopens += 1
    const now = this.now()
    if (this.lastLogMs !== undefined && now - this.lastLogMs < REOPEN_LOG_INTERVAL_MS) {
      return
    }
    this.lastLogMs = now
    console.info(`[persistence] Reopened the idle profile writer (${this.reopens} reopens so far)`)
  }

  recordSuccess(): void {
    this.failure = undefined
  }

  /** Whether the writer may go back to stopped for a retry; a revision conflict stays terminal. */
  recordFailure(error: unknown): boolean {
    if (isRevisionConflict(error)) {
      return false
    }
    const failures = (this.failure?.failures ?? 0) + 1
    // The first retry is immediate; repeated failures back off up to a minute.
    const backoffMs =
      failures === 1 ? 0 : Math.min(1_000 * 2 ** (failures - 2), MAX_REOPEN_BACKOFF_MS)
    this.failure = { error, failures, retryAtMs: this.now() + backoffMs }
    return true
  }
}

function isRevisionConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'profile-state-revision-conflict'
  )
}
