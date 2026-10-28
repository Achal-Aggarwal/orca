import { z } from 'zod'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import type { OrchestrationDb } from '../db'
import { currentRunCoordinatorOrcaSessionIdSql } from '../db/runs/run-coordinator-orca-session'

const nullable = z.string().nullable()
export const CrewAssignment = z.object({
  ordinal: z.number(),
  id: z.string(),
  run_id: z.string(),
  task_id: z.string(),
  assignee_handle: nullable,
  assignee_pane_key: nullable,
  assignee_orca_session_id: nullable,
  creator_handle: nullable,
  creator_pane_key: nullable,
  creator_orca_session_id: nullable,
  creator_dispatch_id: nullable,
  status: z.string(),
  completed_at: nullable,
  spec: z.string(),
  task_title: nullable,
  display_name: nullable,
  task_status: z.string(),
  coordinator_handle: nullable,
  coordinator_pane_key: nullable,
  coordinator_session: nullable,
  stage: nullable,
  agent: nullable,
  host_label: nullable
})
export type CrewAssignmentRow = z.infer<typeof CrewAssignment>

const assignmentColumns = `d.rowid AS ordinal, d.id, d.run_id, d.task_id,
  d.assignee_handle, d.assignee_pane_key, d.assignee_orca_session_id,
  d.creator_handle, d.creator_pane_key, d.creator_orca_session_id, d.creator_dispatch_id,
  d.status, d.completed_at, t.spec, t.task_title, t.display_name, t.status AS task_status,
  r.coordinator_handle, r.coordinator_pane_key,
  ${currentRunCoordinatorOrcaSessionIdSql('r')} AS coordinator_session,
  w.stage, json_extract(w.start_options, '$.agent') AS agent, f.environment_name AS host_label`
const assignmentJoins = `JOIN tasks t ON t.id = d.task_id JOIN runs r ON r.id = d.run_id
  LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
  LEFT JOIN federated_dispatches f ON f.dispatch_id = d.id`

export function readCrewAssignments(db: OrchestrationDb, now: number): CrewAssignmentRow[] {
  const cutoff = new Date(now - AGENT_STATUS_STALE_AFTER_MS).toISOString()
  const sessionIds = db.listSessionDispatchesForPresentation(now).map(({ dispatch }) => dispatch.id)
  return CrewAssignment.array().parse(
    db.db
      .prepare(`
    SELECT ${assignmentColumns} FROM dispatch_contexts d ${assignmentJoins}
    WHERE d.assignee_orca_session_id IS NULL AND d.status IN ('pending', 'dispatched')
    UNION ALL
    SELECT ${assignmentColumns} FROM dispatch_contexts d ${assignmentJoins}
    WHERE d.assignee_orca_session_id IS NULL AND d.status NOT IN ('pending', 'dispatched') AND julianday(d.completed_at) >= julianday(?)
      AND NOT EXISTS (SELECT 1 FROM dispatch_contexts newer WHERE newer.rowid > d.rowid
        AND ((d.assignee_orca_session_id IS NOT NULL AND newer.assignee_orca_session_id = d.assignee_orca_session_id)
          OR (d.assignee_handle IS NOT NULL AND newer.assignee_handle = d.assignee_handle)))
    UNION ALL
    SELECT ${assignmentColumns} FROM dispatch_contexts d ${assignmentJoins}
    WHERE d.id IN (SELECT value FROM json_each(?))
    ORDER BY ordinal DESC
  `)
      .all(cutoff, JSON.stringify(sessionIds))
  )
}

export function readCrewMailboxAssignments(
  db: OrchestrationDb,
  addresses: string[]
): CrewAssignmentRow[] {
  const ids = addresses
    .filter((address) => address.startsWith('dispatch:'))
    .map((address) => address.slice(9))
  return ids.length === 0
    ? []
    : CrewAssignment.array().parse(
        db.db
          .prepare(`
    SELECT ${assignmentColumns} FROM dispatch_contexts d ${assignmentJoins}
    WHERE d.id IN (SELECT value FROM json_each(?))
  `)
          .all(JSON.stringify(ids))
      )
}

const Traffic = z.object({
  peer: z.string(),
  direction: z.enum(['to', 'from']),
  sequence: z.number(),
  body: z.string(),
  created_at: z.string()
})
export type CrewTraffic = z.infer<typeof Traffic>

/** Pair maxima follow enumeration, so a busy mailbox cannot crowd out its quieter peers. */
export function readCrewTraffic(
  db: OrchestrationDb,
  aliases: string[],
  cutoff: string
): CrewTraffic[] {
  return Traffic.array().parse(
    db.db
      .prepare(`
    WITH traffic AS (
      SELECT to_handle AS peer, 'to' AS direction, sequence, body, created_at
      FROM messages WHERE from_handle IN (SELECT value FROM json_each(?))
        AND julianday(created_at) >= julianday(?) AND type <> 'heartbeat'
      UNION ALL
      SELECT from_handle AS peer, 'from' AS direction, sequence, body, created_at
      FROM messages WHERE to_handle IN (SELECT value FROM json_each(?))
        AND julianday(created_at) >= julianday(?) AND type <> 'heartbeat'
    ), peers AS (SELECT peer, MAX(sequence) AS sequence FROM traffic GROUP BY peer)
    SELECT traffic.peer, traffic.direction, traffic.sequence, traffic.body, traffic.created_at
    FROM peers JOIN traffic ON traffic.peer = peers.peer AND traffic.sequence = peers.sequence
    ORDER BY traffic.sequence DESC
  `)
      .all(JSON.stringify(aliases), cutoff, JSON.stringify(aliases), cutoff)
  )
}

export function readCrewQuestions(db: OrchestrationDb, aliases: string[]) {
  return z
    .object({ dispatch_id: z.string(), body: z.string(), created_at: z.string() })
    .array()
    .parse(
      db.db
        .prepare(`SELECT q.dispatch_id, m.body, m.created_at FROM messages m
      JOIN question_threads q ON q.message_id = m.id AND q.status = 'pending'
      WHERE m.to_handle IN (SELECT value FROM json_each(?)) ORDER BY m.sequence DESC
    `)
        .all(JSON.stringify(aliases))
    )
}

export function readCrewRuns(db: OrchestrationDb, addresses: string[]) {
  const ids = addresses
    .filter((address) => address.startsWith('run:'))
    .map((address) => address.slice(4))
  return z
    .object({ id: z.string(), handle: nullable, pane: nullable, session: nullable })
    .array()
    .parse(
      db.db
        .prepare(`SELECT id, coordinator_handle AS handle, coordinator_pane_key AS pane,
      ${currentRunCoordinatorOrcaSessionIdSql('runs')} AS session FROM runs
      WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(ids))
    )
}

export function readCrewSelfAssignments(
  db: OrchestrationDb,
  party: { terminalHandle: string | null; paneKey: string | null; orcaSessionId: string | null }
) {
  return CrewAssignment.array().parse(
    db.db
      .prepare(`SELECT ${assignmentColumns}
    FROM dispatch_contexts d ${assignmentJoins} WHERE d.assignee_handle = ?
      OR d.assignee_pane_key = ? OR d.assignee_orca_session_id = ?
  `)
      .all(party.terminalHandle, party.paneKey, party.orcaSessionId)
  )
}
