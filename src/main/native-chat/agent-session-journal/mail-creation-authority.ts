import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'

export type MailCreationAuthority = { storeId: string; coverageToken: string }
const TABLE = 'mail_creation_authority'
const triggers = {
  mail_creation_receipt_replace: `CREATE TRIGGER mail_creation_receipt_replace
BEFORE INSERT ON agent_session_command_receipts
WHEN EXISTS (SELECT 1 FROM agent_session_command_receipts
 WHERE operation_id = NEW.operation_id AND caller_key = NEW.caller_key AND status = 'accepted')
BEGIN UPDATE mail_creation_authority SET coverage_token = lower(hex(randomblob(16))) WHERE singleton = 1; END`,
  mail_creation_receipt_delete: `CREATE TRIGGER mail_creation_receipt_delete
AFTER DELETE ON agent_session_command_receipts WHEN OLD.status = 'accepted'
BEGIN UPDATE mail_creation_authority SET coverage_token = lower(hex(randomblob(16))) WHERE singleton = 1; END`,
  mail_creation_receipt_update: `CREATE TRIGGER mail_creation_receipt_update
AFTER UPDATE ON agent_session_command_receipts
WHEN OLD.status = 'accepted' AND (NEW.operation_id IS NOT OLD.operation_id
 OR NEW.caller_key IS NOT OLD.caller_key OR NEW.session_id IS NOT OLD.session_id
 OR NEW.method IS NOT OLD.method OR NEW.status IS NOT OLD.status
 OR NEW.result_json IS NOT OLD.result_json OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.rejection_json IS NOT OLD.rejection_json)
BEGIN UPDATE mail_creation_authority SET coverage_token = lower(hex(randomblob(16))) WHERE singleton = 1; END`
}

function enforcementIntact(db: Database.Database): boolean {
  return Object.entries(triggers).every(
    ([name, sql]) =>
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name)
        ?.sql === sql
  )
}

/** Optional certification must never become an ordinary human store-open prerequisite. */
export function ensureMailCreationAuthority(db: Database.Database): void {
  try {
    runJournalTransaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        store_id TEXT NOT NULL, coverage_token TEXT NOT NULL)`)
      db.prepare(`INSERT OR IGNORE INTO ${TABLE} VALUES (1, ?, ?)`).run(randomUUID(), randomUUID())
      if (!enforcementIntact(db)) {
        db.prepare(`UPDATE ${TABLE} SET coverage_token = ? WHERE singleton = 1`).run(randomUUID())
        for (const [name, sql] of Object.entries(triggers)) {
          db.exec(`DROP TRIGGER IF EXISTS ${name}`)
          db.exec(sql)
        }
      }
    })
  } catch (error) {
    console.warn('[agent-session-journal] mail creation certification unavailable', error)
  }
}

export function readMailCreationAuthority(db: Database.Database): MailCreationAuthority | null {
  try {
    if (!enforcementIntact(db)) {
      return null
    }
    const row = db
      .prepare(`SELECT store_id, coverage_token FROM ${TABLE} WHERE singleton = 1`)
      .get()
    return typeof row?.store_id === 'string' && typeof row.coverage_token === 'string'
      ? { storeId: row.store_id, coverageToken: row.coverage_token }
      : null
  } catch {
    return null
  }
}
