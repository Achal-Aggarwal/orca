import { mailSourceIncarnation } from './db/messages/mail-source-order'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  MailStopCapture,
  MailLineageScope
} from '../../native-chat/agent-session-journal/journal-mail-holds'
import type { OrchestrationDb } from './db'
import { sessionMailRecipient } from './session-mail-recipient'

/** Acquires only its own zero-wait reservation; the receipt releases it after journal COMMIT. */
export function captureSessionMailAtStop(
  db: OrchestrationDb | null,
  sessionId: string,
  records: readonly AgentSessionRecord[],
  retire: (db: OrchestrationDb) => void,
  scope?: MailLineageScope | null
): MailStopCapture {
  if (!db || db.db.isTransaction) {
    return {}
  }
  let acquired = false
  let timeout: number | undefined
  const finished = () => {
    let failed = false
    try {
      if (acquired) {
        db.db.exec('ROLLBACK')
        acquired = false
      }
    } catch {
      failed = true
    }
    try {
      if (timeout !== undefined) {
        db.db.pragma(`busy_timeout = ${timeout}`)
      }
    } catch {
      failed = true
    }
    if (failed) {
      try {
        retire(db)
      } catch (error) {
        console.warn('[mail] capture connection retirement failed', error)
      }
    }
  }
  try {
    timeout = Number(db.db.pragma('busy_timeout', { simple: true }))
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      return {}
    }
    db.db.pragma('busy_timeout = 0')
    db.db.exec('BEGIN IMMEDIATE')
    acquired = true
    const recipient = sessionMailRecipient(db, sessionId, records, scope)
    const throughSequence = Number(
      db.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM messages').get()?.n
    )
    const incarnation = mailSourceIncarnation(db.db)
    return {
      cut: {
        incarnation,
        throughSequence,
        direct: [...recipient.direct],
        runs: [...recipient.runs],
        dispatches: [...recipient.dispatches]
      },
      finished
    }
  } catch {
    finished()
    return {}
  }
}
