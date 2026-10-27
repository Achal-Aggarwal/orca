import type { AutomationRun } from '../../shared/automations-types'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../shared/agent-session-turn-record'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { readAutomationRunReceipt } from './automation-run-receipt'
import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'
import type { AutomationRunCompletionObservation } from './run-completion-watcher'
import { tuiAgentDisplayName } from '../../shared/tui-agent-display-names'

export function chatAutomationRunObservation(
  snapshot: AgentJournalSnapshot,
  messageId: string,
  agent: string
): AutomationRunCompletionObservation | null {
  const submission = snapshot.submissions.find((entry) => entry.clientMessageId === messageId)
  if (!submission) {
    return null
  }
  const keys = new Set([
    agentJournalSubmissionKey(messageId),
    ...(submission.providerItemId ? [submission.providerItemId] : [])
  ])
  const turnItem = snapshot.items.find((item) => {
    const turn = readAgentJournalTurn(item.body)
    return (
      turn &&
      !item.agentId &&
      (keys.has(turn.userItemId ?? '') ||
        (submission.answeredInTurn?.via === 'start' &&
          submission.answeredInTurn.turnItemId === item.itemId))
    )
  })
  const turn = turnItem ? readAgentJournalTurn(turnItem.body) : null
  if (!turn || !turnItem) {
    return submission.dispatchState === 'rejected' || submission.dispatchState === 'unknown'
      ? {
          status: 'dispatch_failed',
          error: `${agent} could not confirm this run's prompt. Open the chat before running it again.`
        }
      : null
  }
  if (turn.state === 'running') {
    return null
  }
  const buffer = createHeadlessAutomationOutputSnapshotBuffer()
  for (const item of snapshot.items) {
    if (
      item.agentId ||
      item.turnScope?.kind !== 'turn' ||
      item.turnScope.turnItemId !== turnItem.itemId ||
      item.body.kind !== 'message' ||
      item.body.role !== 'assistant'
    ) {
      continue
    }
    for (const block of item.body.blocks) {
      if (block.type === 'text') {
        buffer.append(`${block.text}\n`)
      }
    }
  }
  const outcome = readAgentJournalTurnOutcome(turn)
  return {
    status: outcome === 'success' ? 'completed' : 'dispatch_failed',
    outputSnapshot: buffer.snapshot(),
    error:
      outcome === 'success'
        ? null
        : outcome === 'cancellation' || turn.state === 'interrupted'
          ? `${agent} was Interrupted. Open the chat or run the automation again.`
          : `${agent} did not complete this run. Open the chat and try again.`
  }
}

export async function observeAutomationChatRun(
  runtime: OrcaRuntimeService,
  run: AutomationRun,
  signal: AbortSignal
): Promise<AutomationRunCompletionObservation> {
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!host || !run.chatSessionId) {
    throw new Error('Chat session unavailable')
  }
  const store = await runtime.openAgentSessionRecordStore()
  const receipt = readAutomationRunReceipt(store, run)
  const agent =
    tuiAgentDisplayName(store.getConversation(run.chatSessionId)?.provider ?? 'Agent') ?? 'Agent'
  if (receipt?.kind !== 'chat' || receipt.sessionId !== run.chatSessionId) {
    return {
      status: 'dispatch_failed',
      error: `${agent} could not confirm this run's prompt. Open the chat before running again.`
    }
  }
  const messageId = receipt.messageId
  const sessionId = run.chatSessionId
  return new Promise((resolve, reject) => {
    let release: (() => void) | undefined
    let settled = false
    let reading = false
    let dirty = false
    const finish = (result?: AutomationRunCompletionObservation, error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
      release?.()
      if (error) {
        reject(error)
      } else {
        resolve(result!)
      }
    }
    const abort = (): void => finish(undefined, new Error('request_aborted'))
    const deadline = setTimeout(
      () =>
        finish({
          status: 'dispatch_failed',
          error: `${agent} did not report a result within 6 hours. Open the chat before running again.`
        }),
      Math.max(1, (run.dispatchedAt ?? run.createdAt) + 6 * 60 * 60 * 1000 - Date.now())
    )
    const read = async (): Promise<void> => {
      if (settled) {
        return
      }
      if (reading) {
        dirty = true
        return
      }
      reading = true
      try {
        do {
          dirty = false
          const observation = chatAutomationRunObservation(
            await host.journalSnapshot(sessionId),
            messageId,
            agent
          )
          if (observation) {
            finish(observation)
            return
          }
        } while (dirty && !settled)
      } catch (error) {
        finish(undefined, error)
      } finally {
        reading = false
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    void host
      .subscribe({
        id: `automation:${run.id}`,
        sessionId,
        emit: (event) => {
          // Token deltas do not change completion; read the full journal only at request/turn boundaries.
          if (
            event.type !== 'batch' ||
            event.batch.submissions.some((entry) => entry.clientMessageId === messageId) ||
            event.batch.items.some((item) => readAgentJournalTurn(item.body))
          ) {
            void read()
          }
        }
      })
      .then(
        (unsubscribe) => {
          release = unsubscribe
          if (settled) {
            unsubscribe()
          } else {
            void read()
          }
        },
        (error) => finish(undefined, error)
      )
  })
}
