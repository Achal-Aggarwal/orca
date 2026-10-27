import { DaemonPtySessionInput } from './daemon-pty-session-input'
import { isUnknownRequestTypeError } from './daemon-endpoint-errors'
import { GET_SIZE_PROTOCOL_VERSION } from './daemon-protocol-version'
import { readDaemonAppliedPtySize, type DaemonAppliedPtySize } from './daemon-pty-applied-size'
import { SessionNotFoundError, type ListSessionsResult } from './types'
import type { PtySpawnResult } from '../providers/pty-provider-contract'
import * as unlistedSession from './daemon-unlisted-session'

export const LIVENESS_PROBE_TIMEOUT_MS = 2_000

export abstract class DaemonPtySessionLiveness extends DaemonPtySessionInput {
  async attach(id: string): Promise<Pick<PtySpawnResult, 'providerSequence' | 'lastTitle'> | void> {
    await this.ensureConnected()
    if (!this.canDelegateBackgroundToDaemon) {
      this.setPtyBackgrounded(id, false)
    }

    // Attach at the proven live size; default geometry could resize an agent TUI or accidentally create a shell.
    // Preserve transport errors: treating lost contact as absence could duplicate or retire a live owner.
    const size = await this.readAppliedSize(id, 'preserve')
    if (!size) {
      throw new SessionNotFoundError(id)
    }
    const result = await this.spawn({
      sessionId: id,
      cols: size.cols,
      rows: size.rows,
      attachOnly: true
    })
    if (result.exitedBeforeSpawnReply) {
      throw new SessionNotFoundError(id)
    }
    // A restarted runtime has never seen the surviving session's title.
    return result.providerSequence || result.lastTitle
      ? {
          ...(result.providerSequence ? { providerSequence: result.providerSequence } : {}),
          ...(result.lastTitle ? { lastTitle: result.lastTitle } : {})
        }
      : undefined
  }

  hasPty(id: string): boolean {
    return this.activeSessionIds.has(id)
  }

  /** Use the same saved-history probe as spawn. */
  hasRestorableHistory(id: string): boolean {
    return this.historyReader?.hasRestorableHistory(id) ?? false
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    try {
      if (!this.getSizeUnsupported && this.protocolVersion >= GET_SIZE_PROTOCOL_VERSION) {
        try {
          const result = await this.client.request<{ size: { cols: number; rows: number } | null }>(
            'getSize',
            { sessionId: id },
            LIVENESS_PROBE_TIMEOUT_MS
          )
          return result.size !== null
        } catch (error) {
          // getSize shipped without a protocol bump; remember rejection instead of trusting the version alone.
          if (!isUnknownRequestTypeError(error)) {
            throw error
          }
          this.getSizeUnsupported = true
        }
      }
      // Legacy listSessions can prove absence; request it directly to avoid publishing inventory audit observations.
      const { sessions } = await this.client.request<ListSessionsResult>(
        'listSessions',
        undefined,
        LIVENESS_PROBE_TIMEOUT_MS
      )
      return sessions.some((session) => session.sessionId === id && session.isAlive)
    } catch {
      return null
    }
  }

  /** Whether this daemon lists the session at all, alive or not; null when it can't answer. */
  listsSession(id: string): Promise<boolean | null> {
    return unlistedSession.readDaemonSessionListing(this.client, id, LIVENESS_PROBE_TIMEOUT_MS)
  }

  // Resize notifications can be dropped; report applied dimensions so the renderer can repair drift.
  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return await this.readAppliedSize(id, 'suppress')
  }

  protected async readAppliedSize(
    id: string,
    failureMode: 'preserve' | 'suppress'
  ): Promise<DaemonAppliedPtySize | null> {
    return await readDaemonAppliedPtySize({
      client: this.client,
      protocolVersion: this.protocolVersion,
      sessionId: id,
      failureMode,
      getSizeUnsupported: this.getSizeUnsupported,
      markGetSizeUnsupported: () => {
        this.getSizeUnsupported = true
      }
    })
  }
}
