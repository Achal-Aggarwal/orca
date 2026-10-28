import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { JournalMailSource } from '../../native-chat/agent-session-journal/journal-mail-boundary'
import type { OrchestrationDb, MessageRow } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import type { SenderNameResolver } from './agent-message-sender'
import { structuredMailBody } from './structured-mail-source'
import {
  messageTypeHasOrchestrationWaiter,
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import { mailSourceIncarnation } from './db/messages/mail-source-order'

export type StructuredPointerTarget = { sessionId: string; dispatchId: string | null }
export type StructuredPointerSendOutcome = { kind: 'queued' | 'unattached' | 'held' }
export type StructuredMailboxPointerHost = {
  readCreation: (
    operationId: string,
    sessionId: string,
    legacy?: true
  ) => 'accepted' | 'absent' | 'unknown'
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

type Dependencies<T extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailbox: string) => ReadonlySet<T> | undefined
  resolveStructuredTarget: (mailbox: string) => StructuredPointerTarget | null
  getCliCommand: () => OrchestrationCliCommand
  senderName: SenderNameResolver
  host: StructuredMailboxPointerHost
  onRetain?: (input: { mailboxHandle: string; sessionId: string; reason: string }) => void
}
type Interest = {
  sessionId: string
  reservedTypes?: ReadonlySet<string>
  running: boolean
  again: boolean
}

/** The adapter ends at ordinary creation. Only the journal queue executes reports. */
export class OrchestrationStructuredMailboxPointerDelivery<T extends OrchestrationMessageWaiter> {
  private recovered = new WeakMap<OrchestrationDb, Set<string>>()
  private readonly interests = new Map<string, Interest>()
  constructor(private readonly deps: Dependencies<T>) {}

  deliverForHandle(mailbox: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailbox)
    if (!target) {
      return false
    }
    let interest = this.interests.get(mailbox)
    if (!interest || interest.sessionId !== target.sessionId) {
      interest = { sessionId: target.sessionId, reservedTypes, running: false, again: false }
      this.interests.set(mailbox, interest)
    }
    interest.reservedTypes = reservedTypes
    if (interest.running) {
      interest.again = true
      return true
    }
    interest.running = true
    const current = interest
    void this.deliver(mailbox, target, current)
      .catch((error) => {
        const db = this.deps.getDb()
        if (db) {
          this.recovered.get(db)?.delete(mailbox)
        }
        console.warn('[orchestration] ordinary mail creation failed', { mailbox, error })
      })
      .finally(() => {
        current.running = false
        if (this.interests.get(mailbox) === current && current.again) {
          current.again = false
          queueMicrotask(() => this.deliverForHandle(mailbox, current.reservedTypes))
        }
      })
    return true
  }

  resetForDatabaseChange(): void {
    this.interests.clear()
    this.recovered = new WeakMap()
  }

  onJournalActivity(sessionId: string): void {
    for (const [mailbox, interest] of this.interests) {
      if (interest.sessionId === sessionId) {
        this.deliverForHandle(mailbox, interest.reservedTypes)
      }
    }
  }
  forgetSession(sessionId: string): void {
    for (const [mailbox, interest] of this.interests) {
      if (interest.sessionId === sessionId) {
        this.interests.delete(mailbox)
      }
    }
  }

  private readCreation(
    db: OrchestrationDb,
    mailbox: string,
    target: StructuredPointerTarget,
    message: MessageRow,
    batchIds: string[]
  ): 'accepted' | 'absent' | 'unknown' {
    const canonical = this.deps.host.readCreation(ordinaryMailCreationId(message), target.sessionId)
    if (canonical !== 'absent') {
      return canonical
    }
    const old = 'handoff' in message ? message.handoff : undefined
    if (old != null) {
      try {
        const hint = z
          .object({
            version: z.literal(1),
            kind: z.literal('structured'),
            operationId: z.string(),
            manifest: z.object({ members: z.array(z.string()) }).optional()
          })
          .parse(JSON.parse(String(old)))
        if (hint.manifest && !hint.manifest.members.includes(message.id)) {
          return 'unknown'
        }
        const receipt = this.deps.host.readCreation(hint.operationId, target.sessionId, true)
        return receipt === 'accepted' ? 'accepted' : 'unknown'
      } catch {
        return 'unknown'
      }
    }
    if (message.ordering_origin != null) {
      return 'absent'
    }
    const hint = db.getStructuredPointerOperation(mailbox)
    if (hint) {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([hint.session_id, batchIds]))
        .digest('base64url')
      if (
        hint.batch_fingerprint === fingerprint &&
        this.deps.host.readCreation(hint.operation_id, target.sessionId, true) === 'accepted'
      ) {
        return 'accepted'
      }
    }
    // An unidentifiable old effect is not permission to create a second card.
    return 'unknown'
  }

  private async deliver(
    mailbox: string,
    target: StructuredPointerTarget,
    interest: Interest
  ): Promise<void> {
    const db = this.deps.getDb()
    if (!db) {
      return
    }
    const current = () =>
      this.deps.getDb() === db &&
      this.interests.get(mailbox) === interest &&
      this.deps.resolveStructuredTarget(mailbox)?.sessionId === target.sessionId
    // Recovery includes read rows: an independent check cannot erase accepted creation.
    let recovered = this.recovered.get(db)
    if (!recovered) {
      recovered = new Set()
      this.recovered.set(db, recovered)
    }
    let after = 0
    while (!recovered.has(mailbox)) {
      const rows = db.db
        .prepare(`SELECT id, sequence FROM messages WHERE to_handle = ?
        AND delivered_at IS NULL AND sequence > ? ORDER BY sequence LIMIT 50`)
        .all(mailbox, after)
      if (!rows.length) {
        recovered.add(mailbox)
        break
      }
      for (const row of rows) {
        after = Number(row.sequence)
        if (typeof row.id !== 'string') {
          throw new Error('unreadable source identity')
        }
        const message = db.getMessageById(row.id)
        if (
          message &&
          this.readCreation(db, mailbox, target, message, [message.id]) === 'accepted'
        ) {
          db.markAsDelivered([message.id], mailbox)
        }
      }
    }
    after = 0
    while (current()) {
      const batch = selectOrchestrationPointerBatch({
        db,
        mailboxHandle: mailbox,
        waiters: this.deps.getMessageWaiters(mailbox),
        reservedTypes: interest.reservedTypes,
        afterSequence: after
      }).messages
      if (!batch.length) {
        return
      }
      for (const message of batch) {
        after = message.sequence
        if (!current()) {
          return
        }
        const operationId = ordinaryMailCreationId(message)
        const receipt = this.readCreation(
          db,
          mailbox,
          target,
          message,
          batch.map((row) => row.id)
        )
        if (receipt === 'unknown') {
          continue
        }
        if (receipt === 'accepted') {
          db.markAsDelivered([message.id], mailbox)
          continue
        }
        const fence = this.deps.host.currentFence(target.sessionId)
        if (fence === null) {
          return
        }
        const body = structuredMailBody({
          ...this.deps,
          db,
          mailboxHandle: mailbox,
          dispatchId: target.dispatchId,
          message,
          cliCommand: this.deps.getCliCommand()
        })
        const outcome = await this.deps.host.send({
          ...target,
          operationId,
          expectedRuntimeFence: fence,
          beforeRun: () => {
            const latest = db.getMessageById(message.id)
            const held = db.getOutstandingMailboxDelivery(mailbox)
            if (
              !current() ||
              !latest ||
              latest.read !== 0 ||
              latest.delivered_at !== null ||
              latest.to_handle !== mailbox ||
              held?.messageIds.includes(message.id) ||
              messageTypeHasOrchestrationWaiter(
                this.deps.getMessageWaiters(mailbox),
                latest.type
              ) ||
              interest.reservedTypes?.has(latest.type)
            ) {
              throw new Error('source creation superseded')
            }
          },
          body,
          mailSource: {
            incarnation: mailSourceIncarnation(db.db),
            sequence: message.sequence,
            origin: message.ordering_origin ?? null
          }
        })
        if (!current()) {
          return
        }
        if (
          outcome.kind === 'queued' ||
          this.deps.host.readCreation(operationId, target.sessionId) === 'accepted'
        ) {
          db.markAsDelivered([message.id], mailbox)
        }
      }
    }
  }
}
