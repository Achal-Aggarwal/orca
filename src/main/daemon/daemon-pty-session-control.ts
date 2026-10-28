import { coldRestorePayloadFromInfo, type ColdRestorePayload } from './cold-restore-payload-cache'
import { isPtyFencedTerminationOutcome } from '../../shared/pty-fenced-termination'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import { sameEndpointIdentity } from './daemon-endpoint-incarnation'
import { FENCED_TERMINATION_PROTOCOL_VERSION } from './daemon-protocol-version'
import { FinalCheckpointWaitExpiredError } from './daemon-pty-lifecycle-errors'
import { DaemonPtySessionLiveness } from './daemon-pty-session-liveness'
export { LIVENESS_PROBE_TIMEOUT_MS } from './daemon-pty-session-liveness'
import { remainingDaemonRequestTimeoutMs, teardownReadBudgetMs } from './daemon-request-deadline'
import type { ColdRestoreInfo } from './history-reader'
import { normalizeWslColdRestoreCwd } from './wsl-cold-restore-cwd'
import { readDaemonWslSleepCwd } from './daemon-wsl-sleep-cwd'
import * as unlistedSession from './daemon-unlisted-session'
import { SessionNotFoundError } from './types'
import { resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import type { PtyShutdownOptions } from '../providers/pty-provider-contract'

const MAX_TOMBSTONES = 1000
// A busy daemon must not eat the final checkpoint's share of the Sleep deadline.
const LIVE_SLEEP_CWD_BUDGET_MS = 1_500

export abstract class DaemonPtySessionControl extends DaemonPtySessionLiveness {
  protected abstract adoptListedSessionForSleep(
    sessionId: string,
    deadlineMs?: number
  ): Promise<void>

  /** The daemons that share this history dir and can answer for it; a router widens this. */
  private listingDaemons: () => readonly unlistedSession.SessionListingDaemon[] = () => [this]

  shareSessionListingWith(daemons: () => readonly unlistedSession.SessionListingDaemon[]): void {
    this.listingDaemons = daemons
  }

  async shutdown(
    id: string,
    opts: PtyShutdownOptions,
    endpoint: DaemonEndpointIdentity | null = this.client.getDaemonIdentity()
  ): Promise<void> {
    if (opts.keepHistory && this.disconnectOnlyPromise) {
      throw new Error('Cannot keep history after daemon disconnect has started')
    }
    if (!opts.keepHistory) {
      await this.withHistorySpawnLock(id, () => this.shutdownWithHistoryLock(id, opts, endpoint))
      return
    }
    const shutdown = Promise.resolve().then(async () => {
      // Outside the spawn lock, which adopting the session's history takes itself.
      await this.ensureConnected(opts.deadlineMs)
      await this.adoptListedSessionForSleep(id, opts.deadlineMs).catch(() => {})
      await this.withHistorySpawnLock(id, () => this.shutdownWithHistoryLock(id, opts, endpoint))
    })
    this.keepHistoryShutdowns.add(shutdown)
    try {
      await shutdown
    } finally {
      this.keepHistoryShutdowns.delete(shutdown)
    }
  }

  protected async shutdownWithHistoryLock(
    id: string,
    opts: PtyShutdownOptions,
    endpoint: DaemonEndpointIdentity | null = this.client.getDaemonIdentity()
  ): Promise<void> {
    const original = opts.expectedIncarnationId
    if (
      opts.authorizeStop &&
      (!original ||
        !endpoint ||
        this.protocolVersion < FENCED_TERMINATION_PROTOCOL_VERSION ||
        this.sessionIncarnations.get(id) !== original)
    ) {
      throw new Error('terminal_stop_identity_unavailable')
    }
    const previousRestore = this.coldRestoreCache.get(id)
    const previouslySlept = this.sleepRestoreSessionIds.has(id)
    const hadWriter = this.historyManager?.hasWriter(id)
    let installedRestore: ColdRestorePayload | null = null
    let sleepCommit: (() => void) | undefined
    // Connect lazily, sharing one deadline with checkpoint waits and kill; durable writes themselves remain unbounded.
    await this.ensureConnected(opts.deadlineMs)
    // Sleep may precede the first periodic checkpoint; persist the screen before killing.
    if (opts.keepHistory) {
      const sleepWslDistro = this.wslDistrosBySessionId.get(id)
      const sleepPaneKey = this.wslPaneKeysBySessionId.get(id)
      const sleepCwd =
        sleepWslDistro && sleepPaneKey
          ? await readDaemonWslSleepCwd(
              {
                paneKey: sleepPaneKey,
                wslDistro: sleepWslDistro,
                // A live pane's own wsl.exe keeps its distro running.
                live: this.activeSessionIds.has(id)
              },
              opts.deadlineMs
            )
          : await this.readLiveSleepCwd(id, opts.deadlineMs)
      const committed = await this.runExclusiveCheckpoint(
        async () => {
          // Set inside: a caller past its deadline leaves this checkpoint running without it.
          if (sleepCwd) {
            this.sleepShellCwds.set(id, sleepCwd)
          }
          try {
            await this.checkpointSessions([id], { final: true, teardown: true })
          } finally {
            this.sleepShellCwds.delete(id)
          }
        },
        { callerDeadlineMs: opts.deadlineMs }
      )
      // Caller timeout leaves the checkpoint running; preserve the live PTY until recovery data is verified.
      if (!committed) {
        throw new FinalCheckpointWaitExpiredError(id)
      }
      const wslDistro = this.wslDistrosBySessionId.get(id)
      const detection = await this.historyReader?.detectColdRestoreState(id, { wslDistro })
      const detected = detection?.status === 'restored' ? detection.restoreInfo : null
      const restoreInfo = detected
        ? {
            ...detected,
            cwd:
              normalizeWslColdRestoreCwd({
                recoveredCwd: detected.cwd,
                requestedCwd: this.initialCwds.get(id) ?? resolveSafePtyDefaultCwd(),
                wslDistro
              }) ?? ''
          }
        : null
      const coldRestore = restoreInfo ? this.buildColdRestorePayload(restoreInfo) : null
      sleepCommit = () => {
        if (coldRestore) {
          installedRestore = coldRestore
          this.coldRestoreCache.set(id, coldRestore)
          if (this.coldRestoreCache.has(id)) {
            this.sleepRestoreSessionIds.add(id)
          }
          // Intentional sleep keeps the final checkpoint authoritative; physical exit must not mark history clean.
          this.historyManager?.suspendSession(id)
        } else if (
          detection?.status === 'unreadable' ||
          (detection?.status === 'restored' && detection.hasUnreadableRecovery)
        ) {
          this.historyManager?.suspendSession(id)
        }
      }
    }
    if (opts.authorizeStop) {
      if (!(await opts.authorizeStop())) {
        throw new Error('terminal_stop_declined')
      }
      const current = this.client.getDaemonIdentity()
      if (
        !current ||
        !endpoint ||
        !sameEndpointIdentity(current, endpoint) ||
        this.sessionIncarnations.get(id) !== original
      ) {
        throw new Error('terminal_stop_identity_changed')
      }
    }
    sleepCommit?.()
    try {
      const result = await this.client.request<unknown>(
        'kill',
        {
          sessionId: id,
          immediate: opts.immediate ?? false,
          ...(opts.authorizeStop
            ? {
                expectedIncarnationId: original,
                requireNoAgentOwner: false,
                requireUnattached: false
              }
            : {})
        },
        remainingDaemonRequestTimeoutMs(opts.deadlineMs)
      )
      if (
        opts.authorizeStop &&
        (!isPtyFencedTerminationOutcome(result) || result.outcome === 'refused')
      ) {
        throw new Error('terminal_stop_unproven')
      }
    } catch (error) {
      if (
        opts.authorizeStop &&
        (await this.probePtyLiveness(id)) === true &&
        this.sessionIncarnations.get(id) === original &&
        endpoint
      ) {
        const currentEndpoint = this.client.getDaemonIdentity()
        if (currentEndpoint && sameEndpointIdentity(currentEndpoint, endpoint)) {
          if (installedRestore && this.coldRestoreCache.get(id) === installedRestore) {
            if (previousRestore) {
              this.coldRestoreCache.set(id, previousRestore)
            } else {
              this.coldRestoreCache.delete(id)
            }
            if (!previouslySlept) {
              this.sleepRestoreSessionIds.delete(id)
            }
          }
          if (hadWriter) {
            this.historyManager?.registerWriter(id)
          }
        }
      }
      // Gone is known for a session this adapter lost, or (after a relaunch forgot that) one whose
      // history is unended and that no daemon sharing the history dir may still run.
      if (
        opts.keepHistory ||
        !(error instanceof SessionNotFoundError) ||
        !(
          this.hostLossSessionIds.has(id) ||
          (await unlistedSession.isUnlistedLostSession(
            id,
            this.historyReader,
            this.runtimeDir,
            this.listingDaemons()
          ))
        )
      ) {
        throw error
      }
    }
    await this.completeShutdownWithHistoryLock(id, opts)
  }

  /** Complete an explicit close without issuing another kill; the caller holds the spawn/history lock. */
  protected async completeShutdownWithHistoryLock(
    id: string,
    opts: { keepHistory?: boolean }
  ): Promise<void> {
    this.activeSessionIds.delete(id)
    this.hostLossSessionIds.delete(id)
    this.clearSessionAwaitingDaemonRecovery(id)
    this.dirtySessionVersions.delete(id)
    if (!opts.keepHistory) {
      this.coldRestoreCache.delete(id)
      this.sleepRestoreSessionIds.delete(id)
    }
    // Explicit close takes no final checkpoint, so clear its pending full-checkpoint state here.
    this.sessionsNeedingFullCheckpoint.delete(id)
    this.sessionsNeedingLiveCheckpoint.delete(id)
    this.sessionsNeedingContinuityCheckpoint.delete(id)
    this.overlayDeadlineWarnedSessionIds.delete(id)
    this.periodicDeadlineWarnedSessionIds.delete(id)
    this.nonFinalAdmissionDeniedSessionIds.delete(id)
    this.lastFullCheckpointAt.delete(id)
    this.stopCheckpointTimerIfIdle()
    this.initialCwds.delete(id)
    this.wslDistrosBySessionId.delete(id)
    this.wslPaneKeysBySessionId.delete(id)
    // Explicit close removes history; sleep preserves it for wake-time recovery.
    if (this.historyManager && !opts.keepHistory) {
      await this.historyManager
        .removeSession(id)
        .catch((err) => console.warn('[history] removeSession failed:', id, err))
    }

    // Tombstone explicit kills, but allow sleep sessions to reattach on wake.
    if (!opts.keepHistory) {
      this.killedSessionTombstones.delete(id)
      this.killedSessionTombstones.set(id, Date.now())
      if (this.killedSessionTombstones.size > MAX_TOMBSTONES) {
        const oldest = this.killedSessionTombstones.keys().next().value
        if (oldest) {
          this.killedSessionTombstones.delete(oldest)
        }
      }
    }
  }

  ackColdRestore(sessionId: string): void {
    this.coldRestoreCache.delete(sessionId)
    this.sleepRestoreSessionIds.delete(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.killedSessionTombstones.delete(sessionId)
  }

  protected buildColdRestorePayload(restoreInfo: ColdRestoreInfo): ColdRestorePayload | null {
    return coldRestorePayloadFromInfo(restoreInfo)
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.client.request('signal', { sessionId: id, signal })
  }

  async getCwd(id: string): Promise<string> {
    try {
      const result = await this.client.request<{ cwd: string | null }>('getCwd', {
        sessionId: id
      })
      return result.cwd ?? ''
    } catch {
      return ''
    }
  }

  /**
   * A native shell's folder at Sleep (OSC 7, else its process's cwd). Bash prints no OSC 7, so
   * without this the checkpoint keeps the spawn folder and Wake opens there (e.g. on a Linux host).
   */
  private async readLiveSleepCwd(id: string, deadlineMs?: number): Promise<string | null> {
    // Windows has no process-cwd lookup (it would spawn a missing lsof); the snapshot's OSC 7 cwd stands.
    const budget = teardownReadBudgetMs(LIVE_SLEEP_CWD_BUDGET_MS, deadlineMs)
    if (process.platform === 'win32' || budget <= 0 || !this.activeSessionIds.has(id)) {
      return null
    }
    try {
      const { cwd } = await this.client.request<{ cwd: string | null }>(
        'getCwd',
        { sessionId: id },
        budget
      )
      // A removed folder reads back from /proc as `<path> (deleted)`, which no shell can return to.
      return cwd && !cwd.endsWith(' (deleted)') ? cwd : null
    } catch {
      return null
    }
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.initialCwds.get(id) ?? ''
  }
}
