import type Database from '../../sqlite/sync-database'
import type { CommandReceiptResult } from '../../native-chat/agent-session-journal/command-receipt-schema'

type HistoryRevision = { value: number; effects: Map<string, Set<string>> }
const revisions = new WeakMap<Database.Database, HistoryRevision>()
const point = (epoch: unknown, sequence: unknown) => JSON.stringify([epoch, sequence])

/** Disposable evidence revision; tokens and canonical appends do not walk old receipts. */
export function mailHistoryRevision(db: Database.Database): number {
  let revision = revisions.get(db)
  if (!revision) {
    revision = { value: 0, effects: new Map() }
    const current = revision
    db.function('invalidate_mail_history', {}, () => {
      current.value++
      return 0
    })
    db.function('mail_history_row_changed', {}, (session, epoch, sequence, messageId) => {
      const keys = typeof session === 'string' ? current.effects.get(session) : undefined
      if (
        keys?.has(point(epoch, sequence)) ||
        (typeof messageId === 'string' && keys?.has(point('draft', messageId)))
      ) {
        current.value++
      }
      return 0
    })
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = event === 'DELETE' ? 'OLD' : 'NEW'
      db.exec(`CREATE TEMP TRIGGER invalidate_mail_receipt_${event.toLowerCase()}
        AFTER ${event} ON main.agent_session_command_receipts
        WHEN ${row}.caller_key LIKE 'trusted-local:orchestration:%'
        AND ${row}.caller_key != 'trusted-local:orchestration:ordinary-mail'
        BEGIN SELECT invalidate_mail_history(); END;`)
      const changed = (prefix: string) => `SELECT mail_history_row_changed(
        ${prefix}.session_id, ${prefix}.epoch, ${prefix}.seq,
        CASE WHEN json_valid(${prefix}.row_json) THEN
          CASE WHEN json_extract(${prefix}.row_json, '$.kind') = 'queue'
            THEN json_extract(${prefix}.row_json, '$.messageId') END END);`
      db.exec(`CREATE TEMP TRIGGER invalidate_mail_body_${event.toLowerCase()}
        AFTER ${event} ON main.journal_rows BEGIN
          ${event === 'UPDATE' ? changed('OLD') : ''} ${changed(row)} END;`)
      db.exec(`CREATE TEMP TRIGGER invalidate_mail_record_${event.toLowerCase()}
        AFTER ${event} ON main.agent_session_records
        ${event === 'UPDATE' ? "WHEN json_extract(CASE WHEN json_valid(OLD.record_json) THEN OLD.record_json ELSE '{}' END, '$.location') IS NOT json_extract(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END, '$.location') OR json_extract(CASE WHEN json_valid(OLD.record_json) THEN OLD.record_json ELSE '{}' END, '$.conversationCommand') IS NOT json_extract(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END, '$.conversationCommand')" : ''}
        BEGIN SELECT invalidate_mail_history(); END;`)
    }
    revisions.set(db, revision)
  }
  return revision.value
}

export function beginMailHistoryInventory(db: Database.Database): void {
  mailHistoryRevision(db)
  revisions.get(db)?.effects.clear()
}
export function observeMailHistoryReference(
  db: Database.Database,
  sessionId: string,
  result: CommandReceiptResult
): void {
  const revision = revisions.get(db)
  if (!revision) {
    return
  }
  const keys = revision.effects.get(sessionId) ?? new Set<string>()
  revision.effects.set(sessionId, keys)
  if (result.kind === 'journal-row') {
    keys.add(point(result.epoch, result.sequence))
  }
  if (result.kind === 'queued-draft') {
    keys.add(point('draft', result.messageId))
  }
}
