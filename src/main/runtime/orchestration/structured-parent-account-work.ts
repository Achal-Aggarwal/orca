import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { OrchestrationDb } from './db'
import { currentRunCoordinatorOrcaSessionIdSql } from './db/runs/run-coordinator-orca-session'
import { structuredWorkerHostScope } from '../structured-worker-identity'

export type NativeResponseEvidence = { pending: Iterable<string>; disposed: ReadonlySet<string> }

/** Canonical created work, not this worker's assigned Dispatch or provider-native children. */
export function structuredParentAccountWork(
  db: OrchestrationDb | null,
  record: AgentSessionRecord,
  root: string,
  response: NativeResponseEvidence
): boolean {
  if (!db || !structuredWorkerHostScope(record.location)) {
    return false
  }
  const mailboxes = db.db
    .prepare(`SELECT 'run:' || run.id AS mailbox, run.id AS run_id FROM runs run
    WHERE run.coordinator_orca_session_id = ? AND ${currentRunCoordinatorOrcaSessionIdSql('run')} = ?
    UNION ALL SELECT 'dispatch:' || id, run_id FROM dispatch_contexts
    WHERE assignee_orca_session_id = ? AND status IN ('pending', 'dispatched')
    UNION ALL SELECT coordinator_handle, id FROM runs WHERE coordinator_orca_session_id = ?
      AND coordinator_orca_session_id_generation = consumer_generation AND coordinator_handle IS NOT NULL
    UNION ALL SELECT assignee_handle, run_id FROM dispatch_contexts WHERE assignee_orca_session_id = ?
      AND status IN ('pending', 'dispatched') AND assignee_handle IS NOT NULL
    UNION ALL SELECT 'orca_session_id:' || ?, id FROM runs WHERE coordinator_orca_session_id = ?
      AND coordinator_orca_session_id_generation = consumer_generation`)
    .all(root, root, root, root, root, root, root)
  const active = db.db
    .prepare(`SELECT 1 FROM dispatch_contexts child
    JOIN tasks task ON task.id = child.task_id
    JOIN runs run ON run.id = child.run_id
    WHERE child.creator_orca_session_id = ? AND child.status IN ('pending', 'dispatched')
      AND (task.created_by_run_generation IS NULL OR task.created_by_run_generation = run.consumer_generation)
      AND ((child.creator_dispatch_id IS NULL AND ${currentRunCoordinatorOrcaSessionIdSql('run')} = ?) OR EXISTS (
        SELECT 1 FROM dispatch_contexts parent WHERE parent.id = child.creator_dispatch_id
          AND parent.status IN ('pending', 'dispatched') AND parent.assignee_orca_session_id = ?)) LIMIT 1`)
    .get(root, root, root)
  if (active) {
    return true
  }
  const unread = db.db.prepare(`SELECT id FROM messages WHERE run_id = ? AND to_handle = ?
    AND type = 'worker_done' AND read = 0 AND delivered_at IS NULL AND delivery_contract <> 'audit_only'`)
  const exact = db.db
    .prepare(`SELECT run_id, to_handle FROM messages WHERE id = ? AND type = 'worker_done'
    AND delivery_contract <> 'audit_only'`)
  const current = new Set<string>()
  for (const mailbox of mailboxes) {
    if (typeof mailbox.mailbox !== 'string' || typeof mailbox.run_id !== 'string') {
      continue
    }
    current.add(`${mailbox.run_id}\0${mailbox.mailbox}`)
    for (const message of unread.all(mailbox.run_id, mailbox.mailbox)) {
      if (typeof message.id === 'string' && !response.disposed.has(message.id)) {
        return true
      }
    }
  }
  // Ack clears unread mail, not an accepted receiving turn that is still running.
  for (const id of response.pending) {
    const message = exact.get(id)
    if (message && current.has(`${message.run_id}\0${message.to_handle}`)) {
      return true
    }
  }
  return false
}
