import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import { latestNativeChatTurnSinceRequest } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import {
  agentSessionProviderRetryDelay,
  type AgentSessionTransientFailure
} from '../../../shared/agent-session-provider-retry-policy'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

const failures = new WeakMap<AgentSessionJournal, Map<string, AgentSessionTransientFailure>>()
const pending = new WeakMap<object, { waiting: () => boolean; retire: () => void }>()

/** Facts are handed over before writes; only committed terminal rows can arm a retry. */
export function noteStructuredAgentSessionTransientFailure(
  journal: AgentSessionJournal,
  identity: AgentJournalItemIdentity,
  category: AgentSessionTransientFailure
): void {
  let facts = failures.get(journal)
  if (!facts) {
    failures.set(journal, (facts = new Map()))
  }
  facts.set(agentJournalItemKey(identity), category)
}

export function structuredAgentSessionProviderRetryPending(journal: object): boolean {
  return pending.get(journal)?.waiting() ?? false
}

export function retireStructuredAgentSessionProviderRetry(journal: object): void {
  pending.get(journal)?.retire()
}

export function structuredAgentSessionStoppedFailure(
  journal: Partial<Pick<AgentSessionJournal, 'snapshot' | 'stopMarks' | 'turnEndedSequence'>>
): string | null {
  if (!journal.snapshot || !journal.stopMarks || !journal.turnEndedSequence) {
    return null
  }
  const stop = journal.stopMarks.latest()
  if (stop?.event.reason !== 'user-stop') {
    return null
  }
  const snapshot = journal.snapshot()
  const latest = latestNativeChatTurnSinceRequest(snapshot.items, snapshot.submissions)
  if (latest?.verdict !== 'failure') {
    return null
  }
  const endedAt = journal.turnEndedSequence(latest.turnItem.itemId)
  return endedAt !== undefined && stop.sequence > endedAt ? latest.turnItem.itemId : null
}

type Retry = {
  journal: AgentSessionJournal
  epoch: string
  fence: number
  child: StructuredAgentSessionHostSession['child']
  failedTurnItemId: string
  failedAtSequence: number
  rootClientMessageId: string
  options?: AgentSessionExecutionOptions
  attempt: number
  category: AgentSessionTransientFailure
  phase: 'waiting' | 'starting' | 'running'
  startedTurnRef?: string
  timer?: ReturnType<typeof setTimeout>
  abort: AbortController
}

export class StructuredAgentSessionProviderRetry {
  private readonly retries = new Map<string, Retry>()

  constructor(
    private readonly deps: {
      continueTurn: NonNullable<StructuredAgentSessionAdapter['continueAfterTransientFailure']>
      session: (id: string) => StructuredAgentSessionHostSession | undefined
      fence: (id: string) => number | null
      serialize: <T>(id: string, task: () => Promise<T>) => Promise<T>
      owesWork: (id: string) => boolean
      publish: (id: string) => void
    }
  ) {}

  retire(id: string): void {
    const retry = this.retries.get(id)
    const journal = retry?.journal ?? this.deps.session(id)?.journal
    if (journal) {
      failures.delete(journal)
    }
    if (!retry) {
      return
    }
    clearTimeout(retry.timer)
    retry.abort.abort()
    this.retries.delete(id)
    pending.delete(retry.journal)
  }

  dispose(): void {
    for (const id of this.retries.keys()) {
      this.retire(id)
    }
  }

  private current(id: string, retry: Retry): boolean {
    return (
      this.retries.get(id) === retry &&
      this.deps.session(id)?.child === retry.child &&
      this.deps.fence(id) === retry.fence &&
      retry.journal.epoch === retry.epoch &&
      !retry.child?.close
    )
  }

  observe(id: string, journal: AgentSessionJournal, rows: readonly JournalRow[] = []): void {
    const previous = this.retries.get(id)
    if (previous && !this.current(id, previous)) {
      this.retire(id)
    }
    if (
      rows.some(
        (row) =>
          row.kind === 'submission' ||
          row.kind === 'epoch' ||
          (row.kind === 'tombstone' && row.stopEvent !== undefined)
      )
    ) {
      this.retire(id)
    }
    for (const row of rows) {
      const mutations = row.kind === 'lifecycle-batch' ? row.mutations : [row]
      for (const mutation of mutations) {
        if (mutation.kind !== 'item' || mutation.body.kind !== 'turn') {
          continue
        }
        const retry = this.retries.get(id)
        if (retry?.startedTurnRef === mutation.body.turnId) {
          retry.phase = 'running'
        }
        if (mutation.body.state === 'running') {
          continue
        }
        const category = failures.get(journal)?.get(mutation.itemId)
        failures.get(journal)?.delete(mutation.itemId)
        this.ended(id, journal, mutation.itemId, row.seq, category)
      }
    }
  }

  private ended(
    id: string,
    journal: AgentSessionJournal,
    itemId: string,
    sequence: number,
    category?: AgentSessionTransientFailure
  ): void {
    const previous = this.retries.get(id)
    if (previous?.failedTurnItemId === itemId) {
      return
    }
    // A very fast provider may finish before its start reply; reconcile after acceptance.
    if (previous?.phase === 'starting' && !previous.startedTurnRef) {
      if (category) {
        failures.get(journal)?.set(itemId, category)
      }
      return
    }
    const snapshot = journal.snapshot()
    const latest = latestNativeChatTurnSinceRequest(snapshot.items, snapshot.submissions)
    if (latest?.turnItem.itemId !== itemId) {
      return
    }
    const turn = latest.turnItem.body
    if (turn.kind !== 'turn') {
      return
    }
    const chain = previous?.startedTurnRef === turn.turnId ? previous : undefined
    if (!category || latest.verdict !== 'failure') {
      if (chain) {
        this.retire(id)
      }
      return
    }
    const root = chain
      ? undefined
      : snapshot.submissions.find(
          (submission) =>
            submission.dispatchState === 'accepted' &&
            submission.answeredInTurn?.via !== 'steer' &&
            turn.userItemId !== undefined &&
            journal.canonicalItemId(turn.userItemId) ===
              journal.canonicalItemId(
                agentJournalItemKey({
                  provider: 'orca',
                  clientMessageId: submission.clientMessageId
                })
              )
        )
    if (!chain && !root) {
      return
    }
    const attempt = chain ? chain.attempt + 1 : 1
    const delay = agentSessionProviderRetryDelay(attempt)
    this.retire(id)
    const session = this.deps.session(id)
    const fence = this.deps.fence(id)
    if (delay === null || !session?.child || fence === null) {
      return
    }
    const retry: Retry = {
      journal,
      epoch: journal.epoch,
      fence,
      child: session.child,
      failedTurnItemId: itemId,
      failedAtSequence: sequence,
      rootClientMessageId: chain?.rootClientMessageId ?? root!.clientMessageId,
      options: chain?.options ?? root?.options,
      attempt,
      category,
      phase: 'waiting',
      abort: new AbortController()
    }
    this.retries.set(id, retry)
    pending.set(journal, {
      waiting: () => this.current(id, retry) && retry.phase !== 'running',
      retire: () => this.retire(id)
    })
    retry.timer = setTimeout(() => {
      void this.deps
        .serialize(id, () => this.fire(id, retry))
        .catch(() => {
          if (this.retries.get(id) === retry) {
            this.retire(id)
            this.deps.publish(id)
          }
        })
    }, delay)
    retry.timer.unref?.()
  }

  private async fire(id: string, retry: Retry): Promise<void> {
    const snapshot = retry.journal.snapshot()
    const latest = latestNativeChatTurnSinceRequest(snapshot.items, snapshot.submissions)
    if (
      !this.current(id, retry) ||
      this.deps.owesWork(id) ||
      latest?.turnItem.itemId !== retry.failedTurnItemId ||
      (retry.journal.stopMarks.latest()?.sequence ?? 0) > retry.failedAtSequence
    ) {
      if (this.retries.get(id) === retry) {
        this.retire(id)
      }
      this.deps.publish(id)
      return
    }
    retry.phase = 'starting'
    const outcome = await this.deps.continueTurn({
      sessionId: id,
      fence: retry.fence,
      options: retry.options,
      signal: retry.abort.signal
    })
    if (!this.current(id, retry)) {
      return
    }
    if (outcome.state !== 'started') {
      this.retire(id)
    } else {
      retry.startedTurnRef = outcome.providerTurnRef
      if (retry.journal.runningTurn()?.turnId === outcome.providerTurnRef) {
        retry.phase = 'running'
      }
      const ended = retry.journal
        .snapshot()
        .items.find(
          (item) =>
            item.body.kind === 'turn' &&
            item.body.turnId === outcome.providerTurnRef &&
            item.body.state !== 'running'
        )
      if (ended) {
        this.ended(
          id,
          retry.journal,
          ended.itemId,
          retry.journal.turnEndedSequence(ended.itemId) ?? ended.sequence,
          failures.get(retry.journal)?.get(ended.itemId)
        )
      }
    }
    this.deps.publish(id)
  }
}
