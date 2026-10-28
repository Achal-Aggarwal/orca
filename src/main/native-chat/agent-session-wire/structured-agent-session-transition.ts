// Admit each event’s writes whole so producer state cannot advance after partial admission.
// Execute against the latest fold in one queue turn; failure retains the written prefix and skips later steps.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalStep } from '../agent-session-journal/journal-step-writer'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionSinkAdmission
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'

export type StructuredAgentSessionTransitionJournal = Pick<
  AgentSessionJournal,
  'epoch' | 'visitItems' | 'itemBody' | 'item' | 'visitItemsWithLinkage' | 'canonicalItemId'
>

export type StructuredAgentSessionTextJournal = StructuredAgentSessionTransitionJournal &
  Pick<AgentSessionJournal, 'textSource' | 'textSourceByRaw' | 'textSources' | 'retireText'>

export type StructuredAgentSessionTransitionStep<
  Journal extends StructuredAgentSessionTransitionJournal = StructuredAgentSessionTextJournal
> =
  | {
      kind: 'item'
      /** Exceeding the reservation fails the sink. */
      reservedBytes: number
      resolve: (journal: Journal) => {
        identity: AgentJournalItemIdentity
        body: AgentJournalItemBody
      } | null
      install?: () => void
      release?: () => void
      options: StructuredAgentSessionItemAppendOptions
    }
  | {
      kind: 'settlement'
      /** Journal deduplicates settlements by this ID. */
      settlementId: string
      recovered?: true
      /** Queue pacing only; the journal chooses actual mutations. */
      reservedBytes: number
      /** Resolve at execution; an empty result writes nothing. */
      resolve: (journal: Journal) => readonly JournalLifecycleMutationInput[]
    }

export type StructuredAgentSessionTransition<
  Journal extends StructuredAgentSessionTransitionJournal = StructuredAgentSessionTextJournal
> = {
  steps: readonly StructuredAgentSessionTransitionStep<Journal>[]
  /** Charge the lifecycle budget for ending/settling work. */
  lifecycle: boolean
  /** Internal admission for bounded provider tails after finalization. */
  finalTail?: true
  publish: boolean
  /** Run after writes and parent publication, in queue order. */
  onPublished?: () => void
}

/** The sink members a transition writer uses. */
export type StructuredAgentSessionTransitionSink<
  Journal extends StructuredAgentSessionTransitionJournal = StructuredAgentSessionTextJournal
> = {
  tryAppendTransition?(
    transition: StructuredAgentSessionTransition<Journal>
  ): StructuredAgentSessionSinkAdmission
  /** null until the sink binds to a journal. */
  journalItems?(): Journal | null
}

export function createStructuredAgentSessionTransitionMembers(
  queue: StructuredAgentSessionSinkQueue,
  hold: (bytes: number) => { install: () => void; release: () => void }
): Required<StructuredAgentSessionTransitionSink> {
  return { tryAppendTransition: transitionAppend(queue, hold), journalItems: queue.journalItems }
}

function transitionAppend(
  queue: StructuredAgentSessionSinkQueue,
  hold: (bytes: number) => { install: () => void; release: () => void }
): (transition: StructuredAgentSessionTransition) => StructuredAgentSessionSinkAdmission {
  return (transition) => {
    const holdCredit = hold(
      transition.steps.reduce(
        (total, step) =>
          total + (step.kind === 'item' && step.options.streamText ? 0 : step.reservedBytes),
        0
      )
    )
    return queue.submit({
      install: () => {
        holdCredit.install()
        for (const step of transition.steps) {
          if (step.kind === 'item') {
            step.install?.()
          }
        }
      },
      release: () => {
        holdCredit.release()
        for (const step of transition.steps) {
          if (step.kind === 'item') {
            step.release?.()
          }
        }
      },
      bytes:
        transition.steps.reduce((total, step) => total + step.reservedBytes, 0) +
        (transition.publish ? 1 : 0),
      lifecycle: transition.lifecycle,
      finalTail: transition.finalTail,
      run: async (bound) => {
        const { journal, fence } = bound
        const wrote = await journal.appendSteps(
          transition.steps.map((step): JournalStep =>
            step.kind === 'item'
              ? {
                  kind: 'item',
                  resolve: () => step.resolve(journal),
                  options: {
                    ...structuredAgentSessionJournalAppendOptions(fence, step.options),
                    reservedBytes: step.reservedBytes
                  }
                }
              : {
                  kind: 'settlement',
                  batch: {
                    settlementId: step.settlementId,
                    fence,
                    ownerFence: fence,
                    recovered: step.recovered,
                    resolve: () => step.resolve(journal)
                  }
                }
          )
        )
        if (transition.publish && wrote.includes(true)) {
          bound.publish()
        }
        transition.onPublished?.()
      }
    })
  }
}
