import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { JournalMailSource } from '../../native-chat/agent-session-journal/journal-mail-boundary'
import type { OrchestrationDb, MessageRow } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import type { SenderNameResolver } from './agent-message-sender'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { MailCreationHistory } from './structured-mail-creation-history'
import { offerMailSource } from './structured-mail-source-offer'
import {
  discoverMailSources,
  type Interest,
  type MailAdmission
} from './structured-mail-source-discovery'
export type { MailAdmission } from './structured-mail-source-discovery'

export type StructuredPointerTarget = { sessionId: string; dispatchId: string | null }
export type StructuredPointerSendOutcome = {
  kind: 'queued' | 'unattached' | 'held' | 'capacity' | 'retry'
}
export type StructuredMailboxPointerHost = {
  readCreation: (
    operationId: string,
    sessionId: string,
    legacy?: true
  ) => 'accepted' | 'absent' | 'unknown'
  readHistory: (sessionId: string) => MailCreationHistory
  admission: (sessionId: string) => MailAdmission | null
  currentFence: (sessionId: string) => number | null
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    beforeRun: () => void
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
    mailSource: JournalMailSource
  }) => Promise<StructuredPointerSendOutcome>
}
export function ordinaryMailCreationId(message: Pick<MessageRow, 'run_id' | 'id'>): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(['ordinary-mail-v1', message.run_id, message.id]))
    .digest('hex')
  return `0000000000001-${hash.slice(0, 32)}`
}

export type MailDeliveryDependencies<T extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailbox: string) => ReadonlySet<T> | undefined
  resolveStructuredTarget: (mailbox: string) => StructuredPointerTarget | null
  getCliCommand: () => OrchestrationCliCommand
  senderName: SenderNameResolver
  host: StructuredMailboxPointerHost
  scheduleRetry?: (mailbox: string) => void
  cancelRetry?: (mailbox: string) => void
  onRetain?: (input: { mailboxHandle: string; sessionId: string; reason: string }) => void
}

/** Disposable finite discovery only; the ordinary queue is the sole executor. */
export class OrchestrationStructuredMailboxPointerDelivery<T extends OrchestrationMessageWaiter> {
  private readonly interests = new Map<string, Interest>()
  private sourceDb: OrchestrationDb | null = null
  constructor(private readonly deps: MailDeliveryDependencies<T>) {
    const db = deps.getDb()
    if (db) {
      this.attachDatabase(db)
    }
  }

  attachDatabase(db: OrchestrationDb): void {
    if (this.sourceDb === db) {
      return
    }
    this.resetForDatabaseChange()
    this.sourceDb = db
    db.mailSourceInserted = (message) => {
      try {
        const interest = this.interest(message.to_handle)
        if (interest && this.sourceDb === db) {
          interest.newSources.add(message.id)
          // Observe this insertion's rollback once, never the unresolved population on tokens.
          queueMicrotask(() => {
            try {
              if (
                this.sourceDb === db &&
                this.deps.getDb() === db &&
                !db.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(message.id)
              ) {
                this.retire(interest, message.id)
              }
            } catch {
              this.retire(interest, message.id)
            }
          })
          if (interest.running) {
            interest.pending = true
          }
          this.deps.scheduleRetry?.(message.to_handle)
        }
      } catch (error) {
        // Observation cannot roll back a valid source or human command.
        console.warn('[orchestration] observing new mail identity failed', error)
      }
    }
  }

  deliverForHandle(mailbox: string, _notificationTypes?: ReadonlySet<string>): boolean {
    const db = this.deps.getDb()
    if (db && this.sourceDb !== db) {
      this.attachDatabase(db)
    }
    const target = this.deps.resolveStructuredTarget(mailbox)
    if (!target) {
      return false
    }
    const interest = this.interest(mailbox)
    if (!interest) {
      return true
    }
    interest.pending = true
    if (!interest.running) {
      interest.running = true
      void discoverMailSources({
        mailbox,
        interest,
        current: () => this.current(mailbox, interest),
        admission: () => this.deps.host.admission(interest.target.sessionId),
        offer: (source) =>
          offerMailSource({
            mailbox,
            interest,
            source,
            deps: this.deps,
            current: () => this.current(mailbox, interest),
            retire: (id) => this.retire(interest, id)
          }),
        retire: (id) => this.retire(interest, id),
        finished: () => {
          this.interests.delete(mailbox)
          this.deps.cancelRetry?.(mailbox)
        }
      })
        .catch((error) => {
          console.warn('[orchestration] ordinary mail creation failed', { mailbox, error })
          interest.retry = true
          this.deps.scheduleRetry?.(mailbox)
        })
        .finally(() => {
          interest.running = false
          if (this.interests.get(mailbox) === interest && interest.pending) {
            queueMicrotask(() => this.deliverForHandle(mailbox))
          }
        })
    }
    return true
  }

  onConsumerChange(mailbox: string): boolean {
    const interest = this.interests.get(mailbox)
    if (interest) {
      interest.consumersChanged = true
    }
    return this.deliverForHandle(mailbox)
  }
  invalidateSource(mailbox: string): void {
    const interest = this.interests.get(mailbox)
    if (interest) {
      interest.frontier = 0
      interest.consumersChanged = true
      interest.history = undefined
    }
  }
  retryForHandle(mailbox: string): void {
    const interest = this.interests.get(mailbox)
    if (interest) {
      interest.retry = true
    }
    this.deliverForHandle(mailbox)
  }
  resetForDatabaseChange(): void {
    if (this.sourceDb) {
      this.sourceDb.mailSourceInserted = undefined
    }
    this.sourceDb = null
    for (const mailbox of this.interests.keys()) {
      this.deps.cancelRetry?.(mailbox)
    }
    this.interests.clear()
  }
  onJournalActivity(sessionId: string): void {
    for (const [mailbox, interest] of this.interests) {
      if (interest.target.sessionId === sessionId) {
        try {
          const now = this.deps.host.admission(sessionId)
          if (
            now?.owner === interest.authority.owner &&
            now.generation === interest.authority.generation
          ) {
            interest.capacityImproved ||= now.queuedBytes < interest.authority.queuedBytes
            interest.authority = now
          }
          this.deliverForHandle(mailbox)
        } catch (error) {
          interest.retry = true
          this.deps.scheduleRetry?.(mailbox)
          console.warn('[orchestration] unfinished semantic mail notification', { mailbox, error })
        }
      }
    }
  }
  forgetSession(sessionId: string): void {
    for (const [mailbox, interest] of this.interests) {
      if (interest.target.sessionId === sessionId) {
        this.interests.delete(mailbox)
        this.deps.cancelRetry?.(mailbox)
      }
    }
  }

  private interest(mailbox: string): Interest | null {
    const db = this.deps.getDb()
    const target = this.deps.resolveStructuredTarget(mailbox)
    const authority = target && this.deps.host.admission(target.sessionId)
    if (!db || !target || !authority) {
      return null
    }
    let interest = this.interests.get(mailbox)
    if (
      !interest ||
      interest.db !== db ||
      interest.target.sessionId !== target.sessionId ||
      interest.authority.owner !== authority.owner ||
      interest.authority.generation !== authority.generation
    ) {
      interest = {
        db,
        target,
        authority,
        frontier: 0,
        deferred: new Map(),
        newSources:
          interest?.db === db &&
          interest.target.sessionId === target.sessionId &&
          interest.authority.owner === authority.owner
            ? interest.newSources
            : new Set(),
        running: false,
        pending: false,
        consumersChanged: false,
        capacityImproved: false,
        retry: false
      }
      this.interests.set(mailbox, interest)
    }
    return interest
  }
  private current(mailbox: string, interest: Interest): boolean {
    if (
      this.deps.getDb() !== interest.db ||
      this.interests.get(mailbox) !== interest ||
      this.deps.resolveStructuredTarget(mailbox)?.sessionId !== interest.target.sessionId
    ) {
      return false
    }
    const authority = this.deps.host.admission(interest.target.sessionId)
    return (
      authority?.owner === interest.authority.owner &&
      authority.generation === interest.authority.generation
    )
  }

  private retire(interest: Interest, id: string): void {
    interest.deferred.delete(id)
    interest.newSources.delete(id)
  }
}
