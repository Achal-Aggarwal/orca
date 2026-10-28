import {
  conversationRecordReader,
  resolveLineageRunningSession
} from './structured-session-lineage'
import { structuredSessionGateFacts } from './structured-session-pointer-delivery'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'
import { sendAgentTurn } from './send-agent-turn'

const MAIL_CALLER = 'trusted-local:orchestration:ordinary-mail'

/** One internal seam for ordinary command acceptance; no provider-consumption acknowledgement. */
export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  const readCreation: StructuredMailboxPointerHost['readCreation'] = (
    operationId,
    sessionId,
    legacy
  ) => {
    const host = getStructuredAgentSessionHost()
    if (!host) {
      return 'unknown'
    }
    const read = host.deps.store.readCommandReceipt({ kind: 'global' }, operationId)
    if (read.verdict === 'absent') {
      return 'absent'
    }
    if (read.verdict !== 'readable') {
      return 'unknown'
    }
    const receipt = read.receipt
    const target = resolveLineageRunningSession(
      conversationRecordReader(host.deps.store),
      receipt.sessionId
    )
    const validTarget = target.kind === 'here' && target.sessionId === sessionId
    const validCaller = legacy
      ? receipt.callerKey.startsWith('trusted-local:orchestration:')
      : receipt.callerKey === MAIL_CALLER
    const created =
      receipt.status === 'accepted' &&
      ((receipt.result.kind === 'queued-draft' && receipt.result.messageId === operationId) ||
        (legacy && receipt.result.kind === 'journal-row'))
    return validTarget && validCaller && receipt.method === 'agentSession.send' && created
      ? 'accepted'
      : 'unknown'
  }
  return {
    readCreation,
    currentFence: (sessionId) =>
      getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.currentFence ?? null,
    send: async (input) => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { kind: 'unattached' }
      }
      const prior = readCreation(input.operationId, input.sessionId)
      if (prior === 'accepted') {
        return { kind: 'queued' }
      }
      if (prior !== 'absent') {
        return { kind: 'held' }
      }
      const outcome = await sendAgentTurn({
        kind: 'structured-session',
        host,
        callerKey: MAIL_CALLER,
        sessionId: input.sessionId,
        turn: {
          body: input.body,
          operationId: input.operationId,
          expectedRuntimeFence: input.expectedRuntimeFence,
          delivery: 'queue',
          queueAlways: true,
          mailSource: input.mailSource,
          beforeRun: input.beforeRun
        }
      })
      return { kind: outcome.kind === 'queued' ? 'queued' : 'held' }
    }
  }
}

export const structuredPointerCallerKey = (dispatchId: string): string =>
  `trusted-local:orchestration:${dispatchId}`
export const structuredSessionPointerCallerKey = (sessionId: string): string =>
  `trusted-local:orchestration:session:${sessionId}`

export async function readStructuredSessionGateFacts(sessionId: string) {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const snapshot = await host.journalSnapshot(sessionId)
    return structuredSessionGateFacts(snapshot.items, host.currentWork(sessionId)?.scope)
  } catch {
    return null
  }
}
