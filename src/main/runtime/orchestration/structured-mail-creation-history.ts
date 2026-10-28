import { z } from 'zod'
import {
  mailHistoryRevision,
  beginMailHistoryInventory,
  observeMailHistoryReference
} from './structured-mail-history-revision'
import {
  ordinaryMailCreationId,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import {
  bindMailCreationProof,
  parseMailCreationProof,
  sameMailAuthority
} from './db/messages/mail-creation-proof'
import type { Interest, SourceIdentity } from './structured-mail-source-discovery'
import { parseJournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  conversationRecordReader,
  resolveLineageRunningSession
} from './structured-session-lineage'

export type MailCreationHistory = { members: ReadonlySet<string>; opaque: boolean }
export const mailMemberKey = (runId: string, id: string): string => JSON.stringify([runId, id])

const histories = new WeakMap<
  StructuredAgentSessionHost,
  { db: object; revision: number; history: MailCreationHistory }
>()

/** Retained original membership proves acceptance; an opaque old effect never proves absence. */
export function readMailCreationHistory(
  host: StructuredAgentSessionHost,
  _sessionId: string
): MailCreationHistory {
  const database = host.deps.journalDatabase.db
  const revision = mailHistoryRevision(database)
  const cached = histories.get(host)
  if (cached?.db === database && cached.revision === revision) {
    return cached.history
  }
  beginMailHistoryInventory(database)
  const members = new Set<string>()
  let opaque = false
  const store = host.deps.store
  const reader = conversationRecordReader(store)
  const db = host.deps.journalDatabase.db
  for (const record of store.listConversations()) {
    const target = resolveLineageRunningSession(reader, record.sessionId)
    if (target.kind !== 'here') {
      continue
    }
    const receipts = db
      .prepare(`SELECT operation_id FROM agent_session_command_receipts
      WHERE session_id = ? AND method = 'agentSession.send'
        AND caller_key LIKE 'trusted-local:orchestration:%'
        AND caller_key != 'trusted-local:orchestration:ordinary-mail'`)
      .all(record.sessionId)
    const drafts = new Set<string>()
    const addBody = (json: unknown) => {
      const parsed = typeof json === 'string' ? parseJournalRow(json) : null
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
        return
      }
      for (const member of mail.messages) {
        members.add(mailMemberKey(member.runId, member.messageId))
      }
    }
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
      if (read.receipt.status !== 'accepted') {
        continue
      }
      const result = read.receipt.result
      observeMailHistoryReference(db, record.sessionId, result)
      if (result.kind === 'queued-draft') {
        drafts.add(result.messageId)
      } else if (result.kind === 'journal-row') {
        addBody(
          db
            .prepare(
              `SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?`
            )
            .get(record.sessionId, result.epoch, result.sequence)?.row_json
        )
      } else {
        opaque = true
      }
    }
    // One original-row inventory per domain revision, rather than a history scan per receipt.
    if (drafts.size) {
      const rows = db
        .prepare(`SELECT row_json FROM journal_rows WHERE session_id = ?
        AND json_valid(row_json)
        AND json_extract(row_json, '$.kind') = 'queue'
        AND json_extract(row_json, '$.change.op') = 'queued'
        AND json_extract(row_json, '$.change.queuedAt.epoch') = epoch
        AND json_extract(row_json, '$.change.queuedAt.sequence') + 1 = seq
        ORDER BY epoch, seq`)
        .iterate(record.sessionId)
      for (const row of rows) {
        const parsed = typeof row.row_json === 'string' ? parseJournalRow(row.row_json) : null
        if (parsed?.ok && parsed.row.kind === 'queue' && drafts.delete(parsed.row.messageId)) {
          addBody(row.row_json)
        }
      }
      opaque ||= drafts.size !== 0
    }
  }

  const history = { members, opaque }
  histories.set(host, { db: database, revision, history })
  return history
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
  const proof = parseMailCreationProof(source.creation_proof)
  const authority = host.creationAuthority?.() ?? null
  if (proof && authority) {
    if (proof.authority === 'unbound') {
      if (bindMailCreationProof(interest.db, source.id, authority)) {
        return 'absent'
      }
    } else if (sameMailAuthority(proof.authority, authority)) {
      return 'absent'
    }
  }
  const history = host.readHistory(interest.target.sessionId)
  if (history.members.has(mailMemberKey(source.run_id, source.id))) {
    return 'accepted'
  }
  return 'unknown'
}
function readHint(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
