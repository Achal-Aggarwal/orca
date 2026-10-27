import { journalInputAttemptEnded } from './journal-input-obligations'
// The queue's one view and its writes. A card is folded from the chat's own rows
// (`journal-queue-fold.ts`), so every change to one is a journal row on the journal's own lane,
// committed with whatever else the action writes: the queue keeps no second copy to fall behind.
// Drafts are NEVER owed work: nothing here feeds working status, teardown, or the idle sweep.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessageMoveAnchor,
  AgentSessionQueuedMessageMoveResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import {
  journalQueueRowBuilder,
  type JournalQueueCardChange,
  type JournalQueueRow
} from './journal-queue-events'
import { LegacyQueuedCards } from './journal-queue-import'
import { queuedChangeOf, queueNeedsReopen } from './journal-queue-retention'
import { composeJournalOperationReceipts, type JournalOperationReceipt } from './journal-row-writer'
import type { JournalQueuedMessagesDeps, JournalSubmissionConsume } from './journal-store-contracts'
import {
  deriveQueuePauses,
  journalUserStopInForce,
  nextSendableQueuedCard,
  type DerivedQueuePause,
  type JournalQueuePauseMarks
} from './queued-message-pause'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageHoldReason,
  type QueuedMessageRow
} from './queued-message-table'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import { QueuedMessageEditLeases } from './queued-message-edit-leases'
import { queuedMessageUpdateDecision, type QueuedMessageUpdate } from './queued-message-update'
import {
  adoptUnconfirmedRecovery,
  unconfirmedRecoveryCards,
  type JournalRecoveryWork
} from './journal-unconfirmed-recovery'
import { queuedMessageMovePlan } from './queued-message-move'

export type JournalQueuePlan = {
  rows: ((seq: number, ts: number) => JournalQueueRow)[]
  receipt: JournalOperationReceipt
}

export class JournalQueuedMessages {
  readonly editLeases = new QueuedMessageEditLeases(() => this.list())
  private readonly legacy: LegacyQueuedCards
  recoveryWork: () => JournalRecoveryWork | null = () => null
  private viewed: { key: string; cards: readonly QueuedMessageRow[] } | null = null

  constructor(private readonly deps: JournalQueuedMessagesDeps) {
    this.legacy = new LegacyQueuedCards(deps)
  }

  get sessionId(): string {
    return this.deps.sessionId
  }

  displayState() {
    return this.deps.state()
  }

  revision(): string {
    const { epoch, queue } = this.deps.state()
    return `${epoch}:${queue.revision}:${this.legacy.key()}:${this.deps.state().inputs.revision}:${this.recoveryWork()?.recoveryViewKey() ?? ''}`
  }

  list(): readonly QueuedMessageRow[] {
    const key = this.revision()
    if (this.viewed?.key !== key) {
      const cards = [...this.deps.state().queue.cards.values(), ...this.legacy.cards()]
      cards.push(...unconfirmedRecoveryCards(this.deps.state(), cards, this.recoveryWork()))
      this.viewed = { key, cards: cards.sort((a, b) => a.position - b.position) }
    }
    return this.viewed.cards
  }

  isDerivedRecovery(messageId: string): boolean {
    return messageId.startsWith('recovery:') && !this.deps.state().queue.cards.has(messageId)
  }

  attemptEnded(clientMessageId: string): boolean {
    const state = this.deps.state()
    const send = state.submissions.get(clientMessageId)
    return send !== undefined && journalInputAttemptEnded(state, send, this.recoveryWork())
  }

  get(messageId: string): QueuedMessageRow | null {
    return this.list().find((card) => card.messageId === messageId) ?? null
  }

  // Card insertion, attachment claims and send receipt must commit together.
  insert(
    input: {
      messageId: string
      body: AgentJournalMessageItem
      requireAttachments?: true
      holdReason?: QueuedMessageHoldReason
      options?: AgentSessionExecutionOptions
    },
    receipt?: JournalOperationReceipt
  ): Promise<QueuedMessageRow> {
    const { messageId, body } = input
    const claims: JournalOperationReceipt = {
      write: (db) => this.deps.claimAttachments(db, body, input.requireAttachments === true),
      committed: () => {}
    }
    return this.write(
      () => {
        // Existing IDs are duplicate admission of the same accepted card, never new queue work.
        if (this.get(messageId)) {
          return { changes: [], result: undefined }
        }
        const { epoch, lastSequence } = this.deps.state()
        const position = Math.max(0, ...this.list().map((card) => card.position)) + 1
        const change = {
          op: 'queued' as const,
          body,
          position,
          queuedAt: { epoch, sequence: lastSequence },
          ...(input.holdReason ? { holdReason: input.holdReason } : {}),
          ...(input.options ? { options: input.options } : {})
        }
        return { changes: [{ messageId, change }], result: undefined }
      },
      composeJournalOperationReceipts(claims, ...(receipt ? [receipt] : []))
    ).then(() => {
      const card = this.get(messageId)
      if (!card) {
        throw new Error('agent_session_queued_message_lost')
      }
      return card
    })
  }

  /** Edits invalidate old leases; require only newly referenced uploads so swept images cannot block text fixes. */
  update(input: QueuedMessageUpdate): Promise<AgentSessionQueuedMessageUpdateResult> {
    let edit: { body: AgentJournalMessageItem; previous: AgentJournalMessageItem } | undefined
    const receipt: JournalOperationReceipt = {
      write: (db) => {
        if (edit) {
          this.deps.claimAttachments(db, edit.body, true, edit.previous)
        }
      },
      committed: () => this.editLeases.retire(input.messageId)
    }
    return this.write<AgentSessionQueuedMessageUpdateResult>(() => {
      edit = undefined
      const card = this.get(input.messageId)
      const decision = queuedMessageUpdateDecision(card, this.deps.sessionId, input)
      const derived =
        card?.recovers &&
        !this.deps.state().queue.cards.has(card.messageId) &&
        !this.legacy.adoption(card.messageId)
      if (decision.status !== 'ready') {
        const result =
          decision.status === 'unchanged' && derived
            ? { ...decision, status: 'updated' as const }
            : decision
        return { changes: [], result }
      }
      edit = { body: decision.body, previous: decision.previous }
      const { messageId } = input
      return {
        changes: [
          {
            messageId,
            change: derived
              ? { ...queuedChangeOf(card), body: decision.body }
              : { op: 'edited', body: decision.body }
          }
        ],
        result: { status: 'updated', messageId, fingerprint: decision.fingerprint }
      }
    }, receipt)
  }

  hold(input: { messageIds: readonly string[]; reason: QueuedMessageHoldReason }): Promise<void> {
    return this.write(() => ({
      changes: input.messageIds.flatMap((messageId) => {
        const card = this.get(messageId)
        return card?.state === 'waiting' && card.holdReason !== input.reason
          ? [{ messageId, change: { op: 'held' as const, holdReason: input.reason } }]
          : []
      }),
      result: undefined
    }))
  }

  withdraw(
    messageIds: readonly string[],
    receipt?: JournalOperationReceipt
  ): Promise<QueuedMessageRow[]> {
    if (messageIds.length === 0) {
      return Promise.resolve([])
    }
    return this.write<QueuedMessageRow[]>(() => {
      const cards = messageIds.flatMap((id) => {
        const card = this.get(id)
        return card && isUnsettledQueuedMessage(card) ? [card] : []
      })
      return {
        changes: cards.map(({ messageId }) => ({
          messageId,
          change: { op: 'withdrawn' as const }
        })),
        result: cards.map((card) => ({ ...card, state: 'withdrawn', holdReason: null }))
      }
    }, receipt)
  }

  move(
    input: { messageId: string } & AgentSessionQueuedMessageMoveAnchor,
    receipt?: JournalOperationReceipt
  ): Promise<AgentSessionQueuedMessageMoveResult> {
    return this.write(() => queuedMessageMovePlan(this.list(), input), receipt)
  }

  /** Adopt each selected legacy witness with its action; deletion is optional cleanup after commit. */
  plan(changes: readonly JournalQueueCardChange[]): JournalQueuePlan {
    const rows: JournalQueuePlan['rows'] = []
    const adopted: string[] = []
    for (const { messageId, change } of changes) {
      const source = this.get(messageId)?.recovers
      if (source) {
        rows.push(...this.legacy.witnessRows(source, adopted))
      }
      const own = this.deps.state().queue.cards.has(messageId) || adopted.includes(messageId)
      const adoption = own
        ? null
        : (this.legacy.adoption(messageId) ??
          adoptUnconfirmedRecovery(this.list(), messageId, change))
      if (adoption) {
        rows.push(journalQueueRowBuilder(this.deps.state, messageId, adoption))
        adopted.push(messageId)
      }
      if (change) {
        rows.push(journalQueueRowBuilder(this.deps.state, messageId, change))
      }
    }
    return { rows, receipt: { write: () => {}, committed: () => this.legacy.cleanup(adopted) } }
  }

  proofWitness(clientMessageId: string): JournalQueuePlan['rows'] {
    return this.legacy.witnessRows(clientMessageId)
  }

  /** Validate the acted-on card on the lane; automatic drain must still own the next queued card. */
  assertConsumable(
    input: JournalSubmissionConsume & { consumedAs: string; fingerprint: string }
  ): void {
    const card = this.get(input.messageId)
    const consumable =
      card !== null &&
      card.state === input.expect &&
      card.fingerprint === input.fingerprint &&
      input.consumedAs !== input.messageId
    if (consumable && input.yieldsToPause) {
      const cards = this.list()
      const held = this.editLeases.heldIds(cards)
      const next = nextSendableQueuedCard(this.derivePauses(cards), cards, held)
      if (next?.messageId === input.messageId) {
        return
      }
    } else if (consumable) {
      return
    }
    throw new QueuedMessageNotConsumableError(input.messageId, input.expect)
  }

  /** The bulk move of an earlier build's cards, once per open (`LegacyQueuedCards.importAtOpen`). */
  importAtOpen(): Promise<void> {
    return this.legacy.importAtOpen()
  }

  pauses(): DerivedQueuePause[] {
    return this.derivePauses(this.list())
  }

  awaitReopenMark(): boolean {
    return queueNeedsReopen(this.list(), this.deps.state().submissions)
  }

  userStopInForce(): JournalQueuePauseMarks['latestStop'] {
    const state = this.deps.state()
    return journalUserStopInForce(state.queuePauseMarks, state.latestAcceptedTurnSequence)
  }

  private derivePauses(cards: readonly QueuedMessageRow[]): DerivedQueuePause[] {
    const state = this.deps.state()
    return deriveQueuePauses({
      epoch: state.epoch,
      marks: state.queuePauseMarks,
      latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
      cards,
      reopenFloor: this.deps.reopenFloor()
    })
  }

  /** Resolve after preceding writes; commit receipts with changed rows and skip empty plans. */
  private write<T>(
    plan: () => { changes: readonly JournalQueueCardChange[]; result: T },
    receipt?: JournalOperationReceipt
  ): Promise<T> {
    let planned: { result: T; plan: JournalQueuePlan } | undefined
    return this.deps.writer
      .enqueueRows(
        () => {
          const next = plan()
          planned = { result: next.result, plan: this.plan(next.changes) }
          return planned.plan.rows
        },
        {
          write: (db, row) => {
            planned?.plan.receipt.write(db, row)
            receipt?.write(db, row)
          },
          committed: () => {
            planned?.plan.receipt.committed()
            receipt?.committed()
          }
        }
      )
      .then(() => {
        if (!planned) {
          throw new Error('agent_session_queue_write_unplanned')
        }
        return planned.result
      })
  }
}
