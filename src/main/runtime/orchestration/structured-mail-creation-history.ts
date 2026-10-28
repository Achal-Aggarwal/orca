import { z } from 'zod'
import {
  ordinaryMailCreationId,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import type { Interest, SourceIdentity } from './structured-mail-source-discovery'
import { parseJournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  conversationRecordReader,
  resolveLineageRunningSession
} from './structured-session-lineage'

export type MailCreationHistory = { members: ReadonlySet<string>; opaque: boolean }
export const mailMemberKey = (runId: string, id: string): string => JSON.stringify([runId, id])

/** Retained original membership proves acceptance; an opaque old effect never proves absence. */
export function readMailCreationHistory(
  host: StructuredAgentSessionHost,
  sessionId: string
): MailCreationHistory {
  const members = new Set<string>()
  let opaque = false
  const store = host.deps.store
  const reader = conversationRecordReader(store)
  const db = host.deps.journalDatabase.db
  for (const record of store.listConversations()) {
    const target = resolveLineageRunningSession(reader, record.sessionId)
    if (target.kind !== 'here' || target.sessionId !== sessionId) {
      continue
    }
    const receipts = db
      .prepare(`SELECT operation_id FROM agent_session_command_receipts
      WHERE session_id = ? AND method = 'agentSession.send'
        AND caller_key LIKE 'trusted-local:orchestration:%'`)
      .all(record.sessionId)
    for (const saved of receipts) {
      if (typeof saved.operation_id !== 'string') {
        opaque = true
        continue
      }
      const read = store.readCommandReceipt({ kind: 'global' }, saved.operation_id)
      if (read.verdict !== 'readable') {
        opaque = true
        continue
      }
      const receipt = read.receipt
      if (receipt.status !== 'accepted') {
        continue
      }
      // Canonical cards have exact live indexed replay; they are not legacy census debt.
      if (receipt.callerKey === 'trusted-local:orchestration:ordinary-mail') {
        continue
      }
      const result = receipt.result
      const row =
        result.kind === 'journal-row'
          ? db
              .prepare(`SELECT row_json FROM journal_rows
            WHERE session_id = ? AND epoch = ? AND seq = ?`)
              .get(record.sessionId, result.epoch, result.sequence)
          : result.kind === 'queued-draft'
            ? db
                .prepare(`SELECT row_json FROM journal_rows WHERE session_id = ?
              AND json_extract(row_json, '$.kind') = 'queue'
              AND json_extract(row_json, '$.messageId') = ?
              AND json_extract(row_json, '$.change.op') = 'queued'
              AND json_extract(row_json, '$.change.queuedAt.epoch') = epoch
              AND json_extract(row_json, '$.change.queuedAt.sequence') + 1 = seq
              ORDER BY epoch, seq LIMIT 1`)
                .get(record.sessionId, result.messageId)
            : undefined
      const parsed = typeof row?.row_json === 'string' ? parseJournalRow(row.row_json) : null
      const original = parsed?.ok ? parsed.row : null
      const body =
        original?.kind === 'submission'
          ? original.body
          : original?.kind === 'queue' && original.change.op === 'queued'
            ? original.change.body
            : null
      const mail = body?.from?.orchestration
      if (mail?.message !== 'mail-notice' || mail.messages.length === 0) {
        opaque = true
        continue
      }
      for (const member of mail.messages) {
        members.add(mailMemberKey(member.runId, member.messageId))
      }
    }
  }
  return { members, opaque }
}

export function readSourceCreation(
  host: StructuredMailboxPointerHost,
  interest: Interest,
  source: SourceIdentity
): 'accepted' | 'absent' | 'unknown' {
  const canonical = host.readCreation(ordinaryMailCreationId(source), interest.target.sessionId)
  if (canonical !== 'absent') {
    return canonical
  }
  if (interest.newSources.has(source.id)) {
    return 'absent'
  }
  if (interest.db.hasColumn('messages', 'handoff')) {
    const hint = interest.db.db
      .prepare('SELECT handoff FROM messages WHERE id = ?')
      .get(source.id)?.handoff
    if (typeof hint === 'string') {
      const parsed = z
        .object({
          version: z.literal(1),
          kind: z.literal('structured'),
          operationId: z.string(),
          manifest: z.object({ members: z.array(z.string()) })
        })
        .safeParse(readHint(hint))
      if (
        parsed.success &&
        parsed.data.manifest.members.includes(source.id) &&
        host.readCreation(parsed.data.operationId, interest.target.sessionId, true) === 'accepted'
      ) {
        return 'accepted'
      }
    }
  }
  interest.history ??= host.readHistory(interest.target.sessionId)
  if (interest.history.members.has(mailMemberKey(source.run_id, source.id))) {
    return 'accepted'
  }
  // Source provenance orders content; it cannot close an unobserved original effect domain.
  return 'unknown'
}
function readHint(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
