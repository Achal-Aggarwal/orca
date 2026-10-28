/** Snapshot distinct sender provenance and join mail to its surviving Run, Dispatch and message records. */

import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { MessageRow, OrchestrationDb } from './db'
import { agentMessageSender, type SenderNameResolver } from './agent-message-sender'
import type { OrchestrationCliCommand } from './cli-command'
import { formatMessageForChat } from './formatter'

export type MailSourceMessage = Pick<
  MessageRow,
  'id' | 'from_handle' | 'run_id' | 'type' | 'payload'
>

export function structuredMailSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  message: MailSourceMessage
  senderName: SenderNameResolver
}): AgentMessageSource {
  const message = input.message
  return {
    kind: 'agent',
    senders: [
      agentMessageSender(
        message.from_handle,
        input.db,
        input.senderName,
        reportedDispatchId([message], message.from_handle)
      )
    ],
    orchestration: {
      message: 'mail-notice',
      mailbox: input.mailboxHandle,
      dispatchId: input.dispatchId,
      messages: [{ messageId: message.id, runId: message.run_id, from: message.from_handle }]
    }
  }
}

/** The dispatch a sender's own `worker_done` here reports: the task it just finished, whose
 *  dispatch that report already settled. */
function reportedDispatchId(
  batch: readonly MailSourceMessage[],
  address: string
): string | undefined {
  for (const message of batch) {
    if (message.from_handle !== address || message.type !== 'worker_done' || !message.payload) {
      continue
    }
    try {
      const payload: unknown = JSON.parse(message.payload)
      const dispatchId =
        typeof payload === 'object' && payload !== null && 'dispatchId' in payload
          ? payload.dispatchId
          : undefined
      if (typeof dispatchId === 'string' && dispatchId.length > 0) {
        return dispatchId
      }
    } catch {
      // A payload that does not parse names no dispatch.
    }
  }
  return undefined
}

/** One canonical report is one ordinary attributed queue message. */
export function structuredMailBody(input: {
  db: OrchestrationDb
  mailboxHandle: string
  dispatchId: string | null
  message: MessageRow
  cliCommand: OrchestrationCliCommand
  senderName: SenderNameResolver
}): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: formatMessageForChat(input.message, input.cliCommand).trim() }],
    from: structuredMailSource(input)
  }
}
