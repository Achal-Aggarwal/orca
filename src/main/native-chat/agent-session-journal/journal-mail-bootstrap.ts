import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { journalRowBase } from './journal-row-builders'
import type { JournalRowWriter } from './journal-row-writer'
import type Database from '../../sqlite/sync-database'
import { readMailHoldFacts, readMailHoldRecords, mailLineageValue } from './journal-mail-holds'
import {
  foldJournalMailBoundary,
  unknownJournalMailBoundary,
  type JournalMailBoundary
} from './journal-mail-boundary'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import { commandReceiptResultSchema } from './command-receipt-schema'
import type { JournalReducerState } from './journal-reducer'

/** Read legacy evidence only until a journal baseline has been materialized. */
export function bootstrapJournalMailBoundary(
  db: Database.Database,
  sessionId: string
): JournalMailBoundary {
  try {
    const records = readMailHoldRecords(db)
    const legacy = readMailHoldFacts(db, sessionId, () => records, -1)
    let boundary: JournalMailBoundary =
      legacy.ambiguous || legacy.members.size
        ? {
            status: 'held',
            stop: null,
            cuts: [],
            members: [...legacy.members],
            ambiguous: legacy.ambiguous,
            ...(legacy.scope ? { scope: legacy.scope } : {})
          }
        : { status: 'released', ...(legacy.scope ? { scope: legacy.scope } : {}) }
    if (!legacy.scope?.root) {
      return unknownJournalMailBoundary()
    }
    const byId = new Map(records.map((record) => [record.sessionId, record]))
    let alias: string | null | undefined = legacy.scope.root
    const visited = new Set<string>()
    while (alias && !visited.has(alias)) {
      visited.add(alias)
      const rows = db
        .prepare(`SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch =
        (SELECT epoch FROM journal_sessions WHERE session_id = ?) ORDER BY seq`)
        .all(alias, alias)
      let hasBaseline = false
      for (const stored of rows) {
        const read = parseJournalRow(String(stored.row_json))
        if (read.ok && (hasBaseline || read.row.mailBoundary)) {
          hasBaseline = true
          boundary = foldJournalMailBoundary(boundary, read.row) ?? boundary
        }
      }
      if (alias === sessionId) {
        return { ...boundary, scope: legacy.scope }
      }
      alias = mailLineageValue(byId.get(alias))
    }
    return unknownJournalMailBoundary()
  } catch {
    return unknownJournalMailBoundary()
  }
}

/** Authenticated explicit card Send keeps agent attribution and releases at command acceptance. */
export function restorePersonalQueuedSends(
  db: Database.Database,
  state: JournalReducerState,
  changedRows?: readonly JournalRow[]
): void {
  if (
    changedRows &&
    !changedRows.some(
      (row) => row.kind === 'submission' && row.origin === 'client' && row.queuedMessageId
    )
  ) {
    return
  }
  const rows = db
    .prepare(`SELECT operation_id, result_json FROM agent_session_command_receipts
    WHERE session_id = ? AND method = 'agentSession.queuedMessageSend' AND status = 'accepted'`)
    .all(state.sessionId)
  for (const row of rows) {
    let raw: unknown
    try {
      raw = JSON.parse(String(row.result_json))
    } catch {
      continue
    }
    const result = commandReceiptResultSchema.safeParse(raw)
    if (
      !result.success ||
      result.data.kind !== 'journal-row' ||
      result.data.epoch !== state.epoch
    ) {
      continue
    }
    const submission = state.submissions.get(String(row.operation_id))
    if (
      !submission ||
      submission.submittedSequence !== result.data.sequence ||
      submission.origin !== 'client'
    ) {
      continue
    }
    state.personalQueuedSends.add(submission.clientMessageId)
    const stop = state.mailBoundary?.status === 'held' ? state.mailBoundary.stop : null
    if (
      !stop ||
      stop.sessionId !== state.sessionId ||
      stop.epoch !== state.epoch ||
      result.data.sequence > stop.sequence
    ) {
      state.mailBoundary = {
        status: 'released',
        ...(state.mailBoundary?.scope ? { scope: state.mailBoundary.scope } : {})
      }
    }
    if (submission.dispatchState === 'accepted' && submission.acceptedSequence !== undefined) {
      state.latestAcceptedTurnSequence = Math.max(
        state.latestAcceptedTurnSequence,
        submission.acceptedSequence
      )
      state.mailHandoffs.personSequence = Math.max(
        state.mailHandoffs.personSequence,
        submission.submittedSequence ?? 0
      )
    }
  }
}

export async function initializeJournalMailBoundary(
  db: Database.Database,
  state: () => JournalReducerState,
  writer: Pick<JournalRowWriter, 'append'>
): Promise<void> {
  restorePersonalQueuedSends(db, state())
  if (state().mailBoundary) {
    return
  }
  const boundary = bootstrapJournalMailBoundary(db, state().sessionId)
  state().mailBoundary = boundary
  try {
    await writer.append((seq, ts) => ({
      kind: 'tombstone',
      itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'mail-boundary' }),
      revision: 1,
      mailBoundary: boundary,
      ...journalRowBase(state().epoch, seq, state().highestFence, ts)
    }))
  } catch {
    // Optional bootstrap storage cannot refuse a personal action; the next open retries.
  }
}
