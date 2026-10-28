import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import {
  emptyCrew,
  type OrchestrationCrewSnapshot,
  type OrchestrationCrewRow
} from '../../../../shared/orchestration-crew'
import { parseOrcaSessionAddress } from '../../../../shared/orca-session-address'
import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration-fleet-agent-status-evidence'
import { isPublicOrchestrationAddress } from '../../../../shared/orchestration-agent-reference'
import type { OrchestrationDb } from '../db'
import {
  resolveLineageRunningSession,
  type AgentSessionRecordReader
} from '../structured-session-lineage'
import { crewDisplayName, creatorFirstParent, crewTaskDisplay } from './crew-rules'
import {
  readCrewAssignments,
  readCrewMailboxAssignments,
  readCrewQuestions,
  readCrewRuns,
  readCrewTraffic,
  readCrewSelfAssignments,
  type CrewAssignmentRow
} from './crew-query'

import { createCrewPartyRegistry, type Party } from './crew-parties'
export type CrewReadDependencies = {
  db: OrchestrationDb | null
  retainedDbExists: boolean
  hostKey: string
  records: AgentSessionRecordReader | null
  liveHandle: (handle: string) => boolean
  handleForPane: (pane: string) => string | null
  paneForHandle: (handle: string) => string | null
  name: (party: AgentMessageSender['party'], taskName: string | null) => string | null
  statuses: readonly FleetAgentStatusEvidence[]
  now?: number
}

function preview(body: string): string {
  const bytes = Buffer.from(body)
  return bytes.length <= 1024
    ? body
    : `${bytes
        .subarray(0, 1021)
        .toString('utf8')
        .replace(/\uFFFD$/, '')}…`
}

export function buildCrewSnapshot(
  address: string,
  deps: CrewReadDependencies
): OrchestrationCrewSnapshot {
  const db = deps.db
  if (!db) {
    return emptyCrew(deps.retainedDbExists ? 'unknown' : 'ok')
  }
  const now = deps.now ?? Date.now()
  const cutoff = new Date(now - AGENT_STATUS_STALE_AFTER_MS).toISOString()
  const records = deps.records
  const { party, aliases, parties } = createCrewPartyRegistry(deps)
  const rawSession = parseOrcaSessionAddress(address)
  let self = party(
    rawSession,
    rawSession ? null : address,
    rawSession ? null : deps.paneForHandle(address)
  )
  if (!self) {
    return emptyCrew('unknown')
  }
  const assignments = readCrewAssignments(db, now).sort(
    (a, b) =>
      Number(['pending', 'dispatched'].includes(b.status)) -
        Number(['pending', 'dispatched'].includes(a.status)) || b.ordinal - a.ordinal
  )
  const assignmentsById = new Map(assignments.map((row) => [row.id, row]))
  const assignmentParty = new Map<string, Party>()
  const addAssignment = (row: CrewAssignmentRow): Party => {
    const worker = party(
      row.assignee_orca_session_id,
      row.assignee_handle,
      row.assignee_pane_key,
      `dispatch:${row.id}`
    )!
    assignmentParty.set(row.id, worker)
    aliases.set(`dispatch:${row.id}`, worker.address)
    return worker
  }
  for (const row of readCrewSelfAssignments(db, self)) {
    addAssignment(row)
  }
  for (const row of assignments) {
    addAssignment(row)
    const coordinator = party(
      row.coordinator_session,
      row.coordinator_handle,
      row.coordinator_pane_key
    )
    if (coordinator) {
      aliases.set(`run:${row.run_id}`, coordinator.address)
    }
    party(row.creator_orca_session_id, row.creator_handle, row.creator_pane_key)
  }
  self = parties.get(aliases.get(self.address) ?? self.address) ?? self
  // A peer-only coordinator can have no eligible assignments in its Run.
  const ownedRuns = db.db
    .prepare(
      `SELECT id FROM runs WHERE coordinator_handle = ? OR coordinator_pane_key = ? OR coordinator_orca_session_id = ?`
    )
    .all(self.terminalHandle, self.paneKey, self.orcaSessionId)
  const ownedRunAddresses = ownedRuns.flatMap((run) =>
    typeof run.id === 'string' ? [`run:${run.id}`] : []
  )
  for (const current of readCrewRuns(db, ownedRunAddresses)) {
    const coordinator = party(current.session, current.handle, current.pane)
    if (coordinator) {
      aliases.set(`run:${current.id}`, coordinator.address)
    }
  }
  const selfAliases = () =>
    [...aliases].filter(([, identity]) => identity === self.address).map(([alias]) => alias)
  const traffic = readCrewTraffic(db, selfAliases(), cutoff)
  const mailboxRows = readCrewMailboxAssignments(
    db,
    traffic.map((message) => message.peer)
  )
  for (const row of mailboxRows) {
    addAssignment(row)
  }
  for (const run of readCrewRuns(
    db,
    traffic.map((message) => message.peer)
  )) {
    const coordinator = party(run.session, run.handle, run.pane)
    if (coordinator) {
      aliases.set(`run:${run.id}`, coordinator.address)
    }
  }
  const statuses = new Map(deps.statuses.map((status) => [status.activity.paneKey, status]))
  const rows = new Map<string, OrchestrationCrewRow>()
  const decorate = (
    target: Party,
    role: OrchestrationCrewRow['role'],
    assignment?: CrewAssignmentRow,
    sendAddress?: string
  ): OrchestrationCrewRow => {
    const display = crewTaskDisplay(assignment)
    const evidence = target.paneKey ? statuses.get(target.paneKey) : undefined
    const fresh =
      evidence && now - evidence.clock.at <= AGENT_STATUS_STALE_AFTER_MS ? evidence : undefined
    const title = display.taskTitle || display.displayName
    const live = target.orcaSessionId
      ? resolveLineageRunningSession(records, target.orcaSessionId)
      : null
    const row: OrchestrationCrewRow = {
      partyKey: JSON.stringify([deps.hostKey, target.address]),
      role,
      label: crewDisplayName(
        deps.name(target, display.displayName || display.taskTitle || null),
        title,
        'Agent'
      )!,
      agentKind:
        live?.kind === 'here'
          ? live.record.provider
          : (fresh?.activity.agentType ?? assignment?.agent ?? 'Agent'),
      status:
        fresh?.activity.state ??
        (assignment
          ? ['pending', 'dispatched'].includes(assignment.status)
            ? 'working'
            : 'done'
          : 'unknown'),
      ...(title && assignment ? { task: { title, state: assignment.task_status } } : {}),
      ...(assignment?.stage && !['accepted', 'ready'].includes(assignment.stage)
        ? { progress: assignment.stage.replaceAll('_', ' ') }
        : {}),
      ...(assignment?.host_label ? { hostLabel: assignment.host_label } : {}),
      ...(sendAddress && isPublicOrchestrationAddress(sendAddress) ? { sendAddress } : {})
    }
    if (live?.kind === 'here') {
      row.openTarget = {
        kind: 'chat',
        sessionId: live.sessionId,
        worktreeId: live.record.location.workspaceId
      }
    } else if (target.terminalHandle) {
      row.openTarget = { kind: 'terminal', handle: target.terminalHandle }
    } else if (assignment && !assignment.host_label) {
      row.openTarget = { kind: 'dispatch', address: `dispatch:${assignment.id}` }
    }
    rows.set(target.address, row)
    return row
  }
  const snapshot = emptyCrew('ok')
  const selected = new Set<string>()
  for (const assignment of assignments) {
    const worker = assignmentParty.get(assignment.id)!
    if (selected.has(worker.address)) {
      continue
    }
    selected.add(worker.address)
    const creator =
      (assignment.creator_dispatch_id
        ? assignmentParty.get(assignment.creator_dispatch_id)
        : undefined) ??
      party(
        assignment.creator_orca_session_id,
        assignment.creator_handle,
        assignment.creator_pane_key
      )
    const coordinator = party(
      assignment.coordinator_session,
      assignment.coordinator_handle,
      assignment.coordinator_pane_key
    )
    const parent = creatorFirstParent(
      creator?.address === worker.address ? undefined : creator,
      coordinator,
      coordinator?.address === worker.address
    )
    if (parent?.address === self.address && worker.address !== self.address) {
      snapshot.sections.managing.push(
        decorate(worker, 'worker', assignment, `dispatch:${assignment.id}`)
      )
    } else if (worker.address === self.address && parent && parent.address !== self.address) {
      const parentAssignment = assignment.creator_dispatch_id
        ? assignmentsById.get(assignment.creator_dispatch_id)
        : undefined
      const sendAddress =
        creator?.address === parent.address
          ? parentAssignment
            ? `dispatch:${parentAssignment.id}`
            : parent.address
          : `run:${assignment.run_id}`
      if (!rows.has(parent.address)) {
        snapshot.sections.managedBy.push(decorate(parent, 'manager', parentAssignment, sendAddress))
      }
    }
  }
  const questions = readCrewQuestions(db, selfAliases())
  for (const question of questions) {
    const target = assignmentParty.get(question.dispatch_id)
    const row = target ? rows.get(target.address) : undefined
    if (row && !row.pendingQuestion) {
      row.pendingQuestion = { preview: preview(question.body), at: question.created_at }
    }
  }
  for (const message of traffic) {
    let targetAddress = aliases.get(message.peer)
    if (!targetAddress) {
      const parsed = parseOrcaSessionAddress(message.peer)
      targetAddress = party(parsed, parsed ? null : message.peer, null, message.peer)?.address
    }
    if (!targetAddress || targetAddress === self.address) {
      continue
    }
    const target = parties.get(targetAddress)!
    let row = rows.get(targetAddress)
    if (!row) {
      row = decorate(
        target,
        'peer',
        undefined,
        target.orcaSessionId
          ? target.address
          : (target.terminalHandle ??
              (target.address.startsWith('dispatch:') ? target.address : undefined))
      )
      snapshot.sections.talkingWith.push(row)
    }
    if (!row.latest || message.sequence > row.latest.sequence) {
      row.latest = {
        direction: message.direction,
        preview: preview(message.body),
        at: message.created_at,
        sequence: message.sequence
      }
    }
  }
  return snapshot
}
