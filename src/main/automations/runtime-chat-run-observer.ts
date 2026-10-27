import type { JournalPublication } from '../native-chat/agent-session-wire/structured-agent-session-conversations'
import type { AutomationRun } from '../../shared/automations-types'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../shared/agent-session-wire'
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
  agent: string,
  queued: AgentSessionSendResult | null = null
): AutomationRunCompletionObservation | null {
  if (queued && 'queued' in queued) {
    return queued.queued.state === 'withdrawn' || queued.queued.state === 'returned'
      ? {
          status: 'dispatch_failed',
          error: `${agent} did not receive this queued prompt. Open the chat before running again.`
        }
      : null
  }
  const submission =
    queued && 'submission' in queued
      ? queued.submission
      : snapshot.submissions.find((entry) => entry.clientMessageId === messageId)
  if (!submission) {
    return null
  }
  const turnItem = submissionTurn(snapshot, submission)
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

function submissionTurn(
  snapshot: AgentJournalSnapshot,
  submission: AgentJournalSnapshot['submissions'][number]
) {
  const keys = new Set([
    agentJournalSubmissionKey(submission.clientMessageId),
    ...(submission.providerItemId ? [submission.providerItemId] : [])
  ])
  return snapshot.items.find((item) => {
    const turn = readAgentJournalTurn(item.body)
    return (
      turn &&
      !item.agentId &&
      (keys.has(turn.userItemId ?? '') ||
        (submission.answeredInTurn?.via === 'start' &&
          submission.answeredInTurn.turnItemId === item.itemId))
    )
  })
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
  if (
    receipt?.kind !== 'chat' ||
    receipt.sessionId !== run.chatSessionId ||
    !receipt.messageId ||
    !receipt.accepted
  ) {
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
    let fingerprint = ''
    let source: JournalPublication['source'] = null
    let currentJournal: JournalPublication['journal'] = null
    let cursor: JournalPublication['cursor']
    let revision = 0
    let submissionId = messageId
    let providerItemId: string | null = null
    let turnItemId: string | null = null
    const finish = (result?: AutomationRunCompletionObservation, error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      source = null
      currentJournal = null
      cursor = undefined
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
    const interest = (): string => {
      const journal = currentJournal
      const card = journal?.queuedMessages.get(messageId)
      const entry = journal?.submission(card?.consumedAs ?? submissionId)
      const root = turnItemId ? journal?.item(journal.canonicalItemId(turnItemId)) : null
      const turn = root ? readAgentJournalTurn(root.body) : null
      return JSON.stringify([
        card?.state,
        card?.consumedAs,
        entry?.clientMessageId,
        entry?.dispatchState,
        entry?.providerItemId,
        entry?.answeredInTurn,
        root && turn
          ? [root.itemId, turn.userItemId, turn.state, readAgentJournalTurnOutcome(turn)]
          : null
      ])
    }
    const read = async (): Promise<void> => {
      if (settled) {
        return
      }
      if (reading) {
        return
      }
      reading = true
      try {
        do {
          dirty = false
          const version = revision
          const readingSource = source
          const current = () => !settled && version === revision && readingSource === source
          const snapshot = await host.journalSnapshot(sessionId)
          if (!current()) {
            continue
          }
          const queued = await host.queuedSendAnswer(sessionId, messageId)
          if (!current()) {
            continue
          }
          const submission =
            queued && 'submission' in queued
              ? queued.submission
              : snapshot.submissions.find((entry) => entry.clientMessageId === messageId)
          if (submission) {
            submissionId = submission.clientMessageId
            providerItemId = submission.providerItemId
            turnItemId = submissionTurn(snapshot, submission)?.itemId ?? null
          }
          fingerprint = interest()
          const observation = chatAutomationRunObservation(snapshot, messageId, agent, queued)
          if (observation) {
            finish(observation)
            return
          }
        } while (dirty && !settled)
      } catch (error) {
        if (!dirty) {
          finish(undefined, error)
        }
      } finally {
        reading = false
        if (dirty && !settled) {
          queueMicrotask(() => void read())
        }
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    release = host.observeJournalPublications(sessionId, {
      next: (hint) => {
        if (settled) {
          return
        }
        if (hint.kind === 'end') {
          finish(undefined, new Error('Chat session host stopped'))
          return
        }
        currentJournal = hint.journal
        const semantic = interest()
        const rows = hint.rows
        const contiguous =
          cursor &&
          hint.cursor?.epoch === cursor.epoch &&
          rows?.every(
            (row, i) => row.epoch === cursor.epoch && row.seq === cursor.sequence + i + 1
          ) &&
          hint.cursor.sequence === cursor.sequence + rows.length
        const linked = rows?.some((row) => {
          if (row.kind === 'submission') {
            return row.queuedMessageId === messageId && row.clientMessageId !== submissionId
          }
          const mutations = row.kind === 'lifecycle-batch' ? row.mutations : [row]
          return mutations.some((item) => {
            if (item.kind !== 'item') {
              return false
            }
            const turn = readAgentJournalTurn(item.body)
            return (
              (item.body.kind === 'message' && item.body.role === 'user') ||
              (turn &&
                !turnItemId &&
                !item.agentId &&
                (turn.userItemId === providerItemId ||
                  turn.userItemId === agentJournalSubmissionKey(submissionId)))
            )
          })
        })
        const changed =
          source !== hint.source ||
          hint.kind !== 'commit' ||
          !contiguous ||
          semantic !== fingerprint ||
          linked
        source = hint.source
        cursor = hint.cursor
        fingerprint = semantic
        if (changed) {
          revision++
          dirty = true
          queueMicrotask(() => void read())
        }
      },
      error: (error) => finish(undefined, error)
    })
    if (settled) {
      release()
    }
  })
}
