import { isAdmissibleAgentJournalMessageBody } from '../../../shared/agent-session-journal-schemas'
import { selectSessionMail } from './structured-session-mail-target'
import {
  currentSessionMail,
  recordStructuredMailHandoff as record
} from './structured-mailbox-pointer-receipt'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import { readMailHandoff } from './mail-handoff'
import { mailSourceIncarnation } from './db/messages/mail-source-order'
import {
  StructuredMailboxSourceBridge,
  type SessionMailInterest,
  type StructuredPointerTarget
} from './structured-mailbox-pointer-admission'
export type {
  StructuredMailboxPointerHost,
  StructuredPointerSessionFacts,
  StructuredPointerTarget,
  StructuredPointerSendOutcome
} from './structured-mailbox-pointer-admission'

/** Discover and enqueue in source order. Only the ordinary journal queue dispatches provider input. */
export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> extends StructuredMailboxSourceBridge<TWaiter> {
  protected override async deliver(
    mailbox: string,
    target: StructuredPointerTarget,
    interest: SessionMailInterest,
    reservedTypes?: ReadonlySet<string>
  ): Promise<void> {
    const db = interest.db
    const sessionId = target.sessionId
    const current = () => this.currentInterest(sessionId, interest)
    const startingKey = this.deps.host.reconciliationKey?.(sessionId)
    let afterSequence = 0
    let settled: ReadonlySet<string> | undefined
    const reconciled = new Set<string>()
    try {
      while (current()) {
        if (db.db.isTransaction) {
          return
        }
        let nextSettled: ReadonlySet<string> | undefined
        const choice = await selectSessionMail({
          ...this.deps,
          db,
          mailbox,
          target,
          reservedTypes,
          reconciled,
          ownWrite: (write) => write(),
          current,
          afterSequence,
          settle: (read) => settled ?? (nextSettled = this.reconcileIssued(db, sessionId, read))
        })
        settled = settled ?? nextSettled
        if (!choice || !current()) {
          return
        }
        const messages = choice.batch.messages.flatMap((message) => {
          const current = db.getMessageById(message.id)
          return current ? [current] : []
        })
        if (messages.length !== choice.batch.messages.length) {
          return
        }
        const reference = readMailHandoff(messages[0]?.handoff)
        if (reference?.kind !== 'structured' || !reference.manifest) {
          return
        }
        const claimed = { ...choice, batch: { messages, reference } }
        const body: unknown = JSON.parse(reference.manifest.body)
        if (!isAdmissibleAgentJournalMessageBody(body)) {
          return
        }
        const journalKey = this.deps.host.reconciliationKey?.(sessionId)
        const outcome = await this.deps.host.send({
          sessionId,
          dispatchId: choice.target.dispatchId,
          operationId: reference.operationId,
          expectedRuntimeFence: reference.manifest.runtimeFence,
          body,
          mailSource: {
            incarnation: mailSourceIncarnation(db.db),
            mailbox: choice.address,
            members: messages.map((message) => ({
              id: message.id,
              sequence: message.sequence,
              origin: message.ordering_origin ?? null
            }))
          },
          beforeRun: () => current() && currentSessionMail(this.depsWithDb(db), claimed)
        })
        if (!current()) {
          return
        }
        if (outcome.kind === 'superseded' && outcome.noEffect) {
          record(db, choice.address, messages, (member) => ({ ...member, nonAdmission: 'held' }))
          interest.pending ||= journalKey !== this.deps.host.reconciliationKey?.(sessionId)
        }
        if (outcome.kind !== 'queued') {
          // Preserve the canonical operation on attachment, capacity or storage refusal.
          return
        }
        record(db, choice.address, messages, (member) => ({
          ...member,
          phase: 'offered',
          clientMessageId: outcome.clientMessageId ?? member.clientMessageId
        }))
        reconciled.add(reference.operationId)
        afterSequence = choice.batch.messages[0].sequence
        reservedTypes = undefined
      }
    } finally {
      if (current()) {
        interest.inFlight = false
        const finalKey = this.deps.host.reconciliationKey?.(sessionId)
        interest.pending ||= startingKey !== finalKey
        interest.journalKey = finalKey
        if (interest.pending) {
          interest.pending = false
          queueMicrotask(() => {
            if (current()) {
              this.deliverForHandle(mailbox, reservedTypes)
            }
          })
        }
      }
    }
  }

  private depsWithDb(db: SessionMailInterest['db']) {
    return { ...this.deps, db }
  }
}
