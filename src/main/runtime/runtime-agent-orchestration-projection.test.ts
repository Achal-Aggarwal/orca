import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  openAgentSessionRecordStoreOnce,
  releaseAgentSessionRecordStore
} from './agent-session-record-store-slot'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { OrcaRuntimeService } from './orca-runtime'
import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  resultOf,
  idOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord
} from './rpc/orchestration-session-caller-test-fixture'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import type { AgentSessionRecordReader } from './orchestration/structured-session-lineage'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import { OrchestrationDb } from './orchestration/db'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from './structured-worker-identity'

const COORDINATOR_CHAT = testOrcaSessionId('1b6f0c3a-7d2e-4a91-8c55-2e9d4b7a0f13')
const WORKER_CHAT = testOrcaSessionId('9c3e5a17-4b2d-4f60-8e91-0d7a6c2b5e48')
const TERMINAL_WORKER_HANDLE = 'term_worker'
const TERMINAL_WORKER_PANE = 'tab_w:11111111-1111-4111-8111-111111111111'

function chatRow(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}

describe('RuntimeAgentOrchestrationProjection chat lineage', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
    hostRef.current = null
    vi.restoreAllMocks()
  })

  it('nests chat and terminal workers under the chat that dispatched them', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'chat run',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORDINATOR_CHAT
    })
    const chatWorker = {
      handle: mintStructuredWorkerHandle(),
      sessionId: WORKER_CHAT,
      paneKey: mintStructuredWorkerPaneKey(WORKER_CHAT)
    }
    const creator = { kind: 'session', orcaSessionId: COORDINATOR_CHAT } as const
    db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'chat worker' }).id,
      assigneeHandle: chatWorker.handle,
      assigneePaneKey: chatWorker.paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_CHAT),
      creator,
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'terminal worker' }).id,
      assigneeHandle: TERMINAL_WORKER_HANDLE,
      assigneePaneKey: TERMINAL_WORKER_PANE,
      creator,
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const leaf = { ptyId: 'pty_w' } as unknown as RuntimeLeafRecord
    const projection = new RuntimeAgentOrchestrationProjection({
      getDb: () => db,
      getLeaves: () => [leaf],
      getPtys: () => [],
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      issueLeafHandle: () => TERMINAL_WORKER_HANDLE,
      issuePtyHandle: () => '',
      makePaneKey: () => TERMINAL_WORKER_PANE,
      getWorktreeId: () => null,
      getHandleForPaneKey: () => null,
      getPaneKey: () => null,
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getSessionRecords: () => null
    })

    const contexts = projection.buildByPaneKey()

    expect(contexts?.[chatRow(WORKER_CHAT)]?.parentPaneKey).toBe(chatRow(COORDINATOR_CHAT))
    expect(contexts?.[TERMINAL_WORKER_PANE]?.parentPaneKey).toBe(chatRow(COORDINATOR_CHAT))
    // The minted pane key authorizes the worker's mailbox; it must never reach a renderer.
    expect(JSON.stringify(contexts)).not.toContain(chatWorker.paneKey)
    expect(JSON.stringify(contexts)).not.toContain(chatWorker.handle)
  })
})

function projectionFor(db: OrchestrationDb, records: AgentSessionRecordReader | null = null) {
  return new RuntimeAgentOrchestrationProjection({
    getDb: () => db,
    getLeaves: () => [],
    getPtys: () => [],
    paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
    issueLeafHandle: () => '',
    issuePtyHandle: () => '',
    makePaneKey: () => '',
    getWorktreeId: () => null,
    getHandleForPaneKey: () => null,
    getPaneKey: () => null,
    getDispatchAuthority: () => null,
    getAgentStatusSnapshot: () => [],
    getSessionRecords: () => records
  })
}

it('publishes ordinary RPC assignments without registering display authority and honors current Run generations', async () => {
  const h = createSessionCallerHarness(hostRef)
  try {
    const runId = idOf(
      resultOf(
        await h.dispatch(
          orchestrationRequest(
            'orchestration.runCreate',
            { objective: 'public lineage' },
            { sessionId: SESSION_X }
          )
        )
      ).run
    )
    const task = h.db.createTask({ runId, spec: 'existing chat task' })
    const response = await h.dispatch(
      orchestrationRequest(
        'orchestration.dispatch',
        { task: task.id, to: formatOrcaSessionAddress(SESSION_Y) },
        { sessionId: SESSION_X }
      )
    )
    const dispatchId = idOf(resultOf(response).dispatch)
    const projection = h.runtime['agentOrchestrationProjection']
    expect(projection.buildByPaneKey()?.[chatRow(SESSION_Y)]).toMatchObject({
      dispatchId,
      parentPaneKey: chatRow(SESSION_X),
      taskTitle: 'existing chat task'
    })
    h.db.db
      .prepare('UPDATE runs SET coordinator_orca_session_id = ? WHERE id = ?')
      .run(COORDINATOR_CHAT, runId)
    expect(projection.buildByPaneKey()?.[chatRow(SESSION_Y)]?.parentPaneKey).toBe(
      chatRow(SESSION_X)
    )
    h.db.db
      .prepare('UPDATE runs SET coordinator_orca_session_id = ? WHERE id = ?')
      .run(SESSION_X, runId)
    // A callback does not have to populate mailbox authority before the public relationship exists.
    h.runtime.onStructuredSessionStatusForMail({ sessionId: SESSION_Y, status: 'attention' })
    expect(projection.buildByPaneKey()?.[chatRow(SESSION_Y)]?.parentPaneKey).toBe(
      chatRow(SESSION_X)
    )
    h.db.db
      .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = NULL WHERE id = ?')
      .run(dispatchId)
    const terminal = 'offline:11111111-1111-4111-8111-111111111111'
    h.db.db
      .prepare(
        'UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?, consumer_generation = consumer_generation + 1 WHERE id = ?'
      )
      .run('term_old_writer', terminal, runId)
    expect(projection.buildByPaneKey()?.[chatRow(SESSION_Y)]?.parentPaneKey).toBe(terminal)
    h.db.db
      .prepare(
        'UPDATE runs SET coordinator_orca_session_id_generation = consumer_generation WHERE id = ?'
      )
      .run(runId)
    expect(projection.buildByPaneKey()?.[chatRow(SESSION_Y)]?.parentPaneKey).toBe(
      chatRow(SESSION_X)
    )
    h.db.db
      .prepare(
        'UPDATE runs SET coordinator_orca_session_id_generation = NULL, coordinator_handle = ?, coordinator_pane_key = ? WHERE id = ?'
      )
      .run(mintStructuredWorkerHandle(), mintStructuredWorkerPaneKey(SESSION_X), runId)
    expect(projection.buildByPaneKey()?.[chatRow(SESSION_Y)]?.parentPaneKey).toBeUndefined()
    expect(JSON.stringify(projection.buildByPaneKey())).not.toContain('structworker_')
  } finally {
    h.close()
  }
})

it.each([20, 200])(
  'shares forward lineage and DB/attention work across %i workers; each build rederives facts',
  (n) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'shared ancestry',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: SESSION_X
      })
      for (let i = 0; i < n; i++) {
        db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'shared task' }).id,
          assigneeHandle: `ordinary-${i}`,
          creator: { kind: 'session', orcaSessionId: SESSION_X },
          maxDepth: 9999
        })
        db.db
          .prepare(
            'UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE assignee_handle = ?'
          )
          .run(`worker-${i}`, `ordinary-${i}`)
      }
      let endpoint = n
      const read = vi.fn((id: string) => {
        const record = sessionRecord(id)
        const index = id === SESSION_X ? 0 : id.startsWith('edge-') ? Number(id.slice(5)) : endpoint
        return agentSessionConversationView(
          index < endpoint
            ? {
                ...record,
                conversationCommand: {
                  command: 'clear',
                  runtimeFence: record.lease.runtimeFence,
                  operationId: 'clear',
                  callerKey: 'test',
                  phase: 'committed',
                  state: 'completed',
                  replacementSessionId: `edge-${index + 1}`
                }
              }
            : record
        )
      })
      const projection = projectionFor(db, { getRecord: read, listRecords: () => [] })
      const tasks = vi.spyOn(db, 'getTask')
      const runs = vi.spyOn(db, 'getRun')
      const batch = vi.spyOn(db, 'getWorkerAttentionFactsForDispatches')
      const individual = vi.spyOn(db, 'getWorkerAttentionFacts')
      const roster = vi.spyOn(db, 'listSessionDispatchesForPresentation')
      let candidateVisits = 0
      let latestVisits = 0
      db.db.function('lineage_candidate_visit', {}, (_rowid: unknown) => {
        candidateVisits++
        return 1
      })
      db.db.function('lineage_latest_visit', {}, (_rowid: unknown) => {
        latestVisits++
        return 1
      })
      const prepare = db.db.prepare.bind(db.db)
      const sql = vi
        .spyOn(db.db, 'prepare')
        .mockImplementation((query) =>
          prepare(
            query
              .replaceAll(
                'WHERE assignee_orca_session_id IS NOT NULL',
                'WHERE assignee_orca_session_id IS NOT NULL AND lineage_candidate_visit(rowid)'
              )
              .replace(
                'ORDER BY rowid DESC LIMIT 1',
                query.includes('rowid AS n')
                  ? 'AND lineage_latest_visit(rowid) ORDER BY rowid DESC LIMIT 1'
                  : 'ORDER BY rowid DESC LIMIT 1'
              )
          )
        )
      const output = projection.buildByPaneKey()
      expect(Object.keys(output ?? {})).toHaveLength(n)
      expect(
        Object.values(output ?? {}).every(
          (context) => context.parentPaneKey === chatRow(`edge-${n}`)
        )
      ).toBe(true)
      expect(read).toHaveBeenCalledTimes(n + n + 1)
      expect(tasks).toHaveBeenCalledTimes(n)
      expect(runs).toHaveBeenCalledTimes(1)
      expect(roster).toHaveBeenCalledTimes(1)
      expect(candidateVisits).toBe(n)
      expect(latestVisits).toBe(n)
      expect(
        sql.mock.calls.filter(([query]) => query.includes('d.id AS dispatch_id'))
      ).toHaveLength(1)
      expect(
        sql.mock.calls.filter(([query]) => query.includes('FROM attempt_observation_facts'))
      ).toHaveLength(1)
      expect(batch).toHaveBeenCalledTimes(1)
      expect(individual).not.toHaveBeenCalled()
      endpoint++
      read.mockClear()
      expect(
        Object.values(projection.buildByPaneKey() ?? {}).every(
          (context) => context.parentPaneKey === chatRow(`edge-${endpoint}`)
        )
      ).toBe(true)
      expect(read.mock.calls.length).toBeLessThanOrEqual(n + endpoint + 1)
      for (const failure of ['missing', 'error', 'cycle', 'prepared']) {
        read.mockImplementation((id) => {
          if (failure === 'error') {
            throw new Error('unreadable')
          }
          if (failure === 'missing') {
            return null
          }
          const record = sessionRecord(id)
          return agentSessionConversationView({
            ...record,
            conversationCommand: {
              command: 'clear',
              runtimeFence: record.lease.runtimeFence,
              operationId: 'cycle',
              callerKey: 'test',
              phase: failure === 'prepared' ? 'prepared' : 'committed',
              state: 'completed',
              replacementSessionId: SESSION_X
            }
          })
        })
        expect(
          Object.values(projection.buildByPaneKey() ?? {}).every(
            (context) => context.parentPaneKey === chatRow(SESSION_X)
          )
        ).toBe(true)
      }
    } finally {
      db.close()
    }
  }
)

it.each([20, 200])(
  'derives newest active null-address sessions from one complete batch at %i identities',
  (n) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'null-address history',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: SESSION_X
      })
      const task = db.createTask({ runId: run.id, spec: 'null-address selection' })
      const insert = db.db.prepare(`INSERT INTO dispatch_contexts
      (id, run_id, task_id, assignee_orca_session_id, status, completed_at)
      WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < ?)
      SELECT ? || n, ?, ?, ?, 'completed', '2020-01-01T00:00:00Z' FROM seq`)
      for (let i = 0; i < n; i++) {
        const dispatch = db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'active selection' }).id,
          assigneeHandle: `old-${i}`,
          creator: { kind: 'system' },
          maxDepth: 99
        })
        db.db
          .prepare(
            'UPDATE dispatch_contexts SET assignee_handle = NULL, assignee_pane_key = NULL, assignee_orca_session_id = ? WHERE id = ?'
          )
          .run(`null-session-${i}`, dispatch.id)
        insert.run(n, `expired-${i}-`, run.id, task.id, `null-session-${i}`)
      }
      let candidates = 0
      db.db.function('null_candidate_visit', {}, (_rowid: unknown) => {
        candidates++
        return 1
      })
      const prepare = db.db.prepare.bind(db.db)
      const trace = vi
        .spyOn(db.db, 'prepare')
        .mockImplementation((query) =>
          prepare(
            query.replaceAll(
              'WHERE assignee_orca_session_id IS NOT NULL',
              'WHERE assignee_orca_session_id IS NOT NULL AND null_candidate_visit(rowid)'
            )
          )
        )
      const roster = vi.spyOn(db, 'listSessionDispatchesForPresentation')
      const projection = projectionFor(db)
      const output = projection.buildByPaneKey() ?? {}
      expect(Object.keys(output)).toHaveLength(n)
      for (let i = 0; i < n; i++) {
        expect(output[chatRow(`null-session-${i}`)]?.parentPaneKey).toBe(chatRow(SESSION_X))
      }
      expect(roster).toHaveBeenCalledTimes(1)
      expect(candidates).toBe(n)
      expect(
        trace.mock.calls.filter(
          ([q]) =>
            q.includes('rowid AS n') &&
            q.includes('assignee_orca_session_id') &&
            q.includes("AND status IN ('pending', 'dispatched')")
        )
      ).toHaveLength(0)
      expect(
        trace.mock.calls.filter(([q]) => q.includes('idx_dispatch_session_presentation'))
      ).toHaveLength(1)
      trace.mockRestore()
      // The newer handled active row contributes to the session maximum even if its address is suppressed.
      const handled = db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: 'active selection' }).id,
        assigneeHandle: 'new-handled',
        creator: { kind: 'system' },
        maxDepth: 99
      })
      db.db
        .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
        .run('null-session-0', handled.id)
      const newer = db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: 'active selection' }).id,
        assigneeHandle: 'newer-suppression',
        creator: { kind: 'system' },
        maxDepth: 99
      })
      db.db
        .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
        .run('new-handled', newer.id)
      const suppressed = projection.buildByPaneKey() ?? {}
      expect(suppressed[chatRow('null-session-0')]).toBeUndefined()
      expect(Object.keys(suppressed)).toHaveLength(n - 1)
    } finally {
      db.close()
    }
  }
)

it('selects indexed active/latest per address with exact ISO/SQLite recency and deterministic public collisions', () => {
  const db = new OrchestrationDb(':memory:')
  const now = Date.parse('2026-10-27T00:00:10.000Z')
  try {
    const emptyRoster = vi.spyOn(db, 'listSessionDispatchesForPresentation')
    const emptyRead = vi.fn(() => null)
    expect(
      projectionFor(db, { getRecord: emptyRead, listRecords: () => [] }).buildByPaneKey()
    ).toBeUndefined()
    expect(emptyRoster).not.toHaveBeenCalled()
    expect(emptyRead).not.toHaveBeenCalled()
    const version = db.db.pragma('user_version', { simple: true })
    const run = db.createRun({
      objective: 'selection',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: 'c:11111111-1111-4111-8111-111111111111'
    })
    let counter = 0
    const add = (
      handle: string,
      session: string | null,
      status: string,
      completed: string | null
    ) => {
      const row = db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: 'selection' }).id,
        assigneeHandle: `${handle}-${counter++}`,
        creator: { kind: 'system' },
        maxDepth: 99
      })
      db.db
        .prepare(
          'UPDATE dispatch_contexts SET assignee_handle = ?, assignee_orca_session_id = ?, status = ?, completed_at = ? WHERE id = ?'
        )
        .run(handle, session, status, completed, row.id)
      return row.id
    }
    add('suppressed', SESSION_X, 'completed', '2026-10-27T00:00:00Z')
    add('suppressed', null, 'failed', null)
    const sqlite = add('sqlite', SESSION_Y, 'completed', '2026-10-26 23:59:59')
    add('expired', 'expired', 'completed', '2020-01-01T00:00:00Z')
    add('invalid', 'invalid', 'completed', 'zzzz')
    add('missing', 'missing', 'failed', null)
    const future = add('future', 'future', 'failed', '2099-01-01T00:00:00Z')
    const active = add('active', SESSION_Y, 'dispatched', null)
    add('same-address', 'active-old', 'pending', null)
    const newest = add('same-address', 'active-new', 'pending', null)
    expect(
      db
        .listSessionDispatchesForPresentation(now)
        .map((row) => row.dispatch.id)
        .sort()
    ).toEqual([newest, active, future, sqlite].sort())
    const noHandle = add('null-handle', 'null-address', 'dispatched', null)
    db.db.prepare('UPDATE dispatch_contexts SET assignee_handle = NULL WHERE id = ?').run(noHandle)
    expect(
      db.listSessionDispatchesForPresentation(now).some((row) => row.dispatch.id === noHandle)
    ).toBe(true)
    const columns = db.db.prepare('PRAGMA index_info(idx_dispatch_session_presentation)').all()
    expect(columns).toMatchObject([{ name: 'status' }, { name: 'completed_at' }])
    db.createMailboxDeliveryIndexesIfPossible()
    expect(db.db.pragma('user_version', { simple: true })).toBe(version)
    const plan = JSON.stringify(
      db.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT rowid FROM dispatch_contexts INDEXED BY idx_dispatch_session_presentation WHERE assignee_orca_session_id IS NOT NULL AND status = 'completed' AND completed_at >= ?"
        )
        .all('2026-10-26')
    )
    expect(plan).toContain('idx_dispatch_session_presentation (status=? AND completed_at>?)')
    expect(projectionFor(db).buildByPaneKey()?.[chatRow(SESSION_Y)]?.dispatchId).toBe(active)
    const latestActive = add('cleared-address', SESSION_X, 'pending', null)
    add('newer-recent-address', SESSION_Y, 'completed', '2099-01-01T00:00:00Z')
    const read = (id: string) => {
      const record = sessionRecord(id)
      return agentSessionConversationView(
        id === SESSION_X
          ? {
              ...record,
              conversationCommand: {
                command: 'clear',
                runtimeFence: record.lease.runtimeFence,
                operationId: 'destination',
                callerKey: 'test',
                phase: 'committed',
                state: 'completed',
                replacementSessionId: SESSION_Y
              }
            }
          : record
      )
    }
    const sharedDestination = projectionFor(db, {
      getRecord: read,
      listRecords: () => []
    }).buildByPaneKey()
    expect(sharedDestination?.[chatRow(SESSION_Y)]?.dispatchId).toBe(latestActive)
    expect(sharedDestination?.[chatRow(SESSION_X)]).toBeUndefined()
  } finally {
    db.close()
  }
})

it.skipIf(process.env.ORCA_LINEAGE_BENCH !== '1')(
  'benchmarks retained-history ranges and first derived-index creation (admitted machines only)',
  () => {
    for (const nullAddress of [false, true]) {
      for (const history of [10_000, 100_000]) {
        for (const terminalHistory of [0, 100_000]) {
          for (const attentionFacts of [0, 2_000]) {
            const directory = mkdtempSync(join(tmpdir(), 'orca-lineage-benchmark-'))
            const path = join(directory, 'orchestration.sqlite')
            let db = new OrchestrationDb(path)
            try {
              const run = db.createRun({
                objective: 'benchmark',
                coordinatorHandle: null,
                coordinatorPaneKey: null,
                coordinatorOrcaSessionId: SESSION_X
              })
              for (let i = 0; i < 20; i++) {
                db.createDispatchContext({
                  taskId: db.createTask({ runId: run.id, spec: 'active' }).id,
                  assigneeHandle: formatOrcaSessionAddress(
                    testOrcaSessionId(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
                  ),
                  creator: { kind: 'system' },
                  maxDepth: 99
                })
              }
              if (nullAddress) {
                db.db.exec(
                  "UPDATE dispatch_contexts SET assignee_handle = NULL, assignee_pane_key = NULL WHERE status = 'pending'"
                )
              }
              const taskId = db.createTask({ runId: run.id, spec: 'history' }).id
              const insert = db.db
                .prepare(`INSERT INTO dispatch_contexts(id, run_id, task_id, assignee_handle, assignee_orca_session_id, status, completed_at)
        WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < ?)
        SELECT ? || n, ?, ?, ? || n, CASE WHEN ? THEN CASE WHEN ? THEN printf('00000000-0000-4000-8000-%012d', (n-1) % 20) ELSE 'session-' || n END ELSE NULL END, 'completed', '2020-01-01T00:00:00Z' FROM seq`)
              insert.run(
                history,
                'session-history-',
                run.id,
                taskId,
                'session-address-',
                1,
                nullAddress ? 1 : 0
              )
              if (terminalHistory) {
                insert.run(
                  terminalHistory,
                  'terminal-history-',
                  run.id,
                  taskId,
                  'terminal-address-',
                  0,
                  0
                )
              }
              const active = db.db
                .prepare(
                  "SELECT id, task_id FROM dispatch_contexts WHERE status = 'pending' ORDER BY rowid"
                )
                .all()
              const insertFact = db.db.prepare(
                `INSERT INTO attempt_observation_facts(id, dispatch_id, task_id, sequence, authority_id, authority_clock, facet, payload, home_received_at) VALUES (?, ?, ?, ?, 'home', 'home', 'process_turn', '{"process":"running","turn":"working"}', ?)`
              )
              for (let i = 0; i < attentionFacts; i++) {
                const row = active[i % active.length]
                if (typeof row?.id !== 'string' || typeof row.task_id !== 'string') {
                  throw new Error('Missing benchmark Dispatch')
                }
                insertFact.run(
                  `observation-${i}`,
                  row.id,
                  row.task_id,
                  Math.floor(i / active.length),
                  Date.now()
                )
              }
              db.db.exec('DROP INDEX idx_dispatch_session_presentation')
              const first = performance.now()
              db.createMailboxDeliveryIndexesIfPossible()
              const indexHelperMs = performance.now() - first
              db.db.exec('DROP INDEX idx_dispatch_session_presentation')
              db.close()
              const openStarted = performance.now()
              db = new OrchestrationDb(path)
              const reopenWithIndexCreationMs = performance.now() - openStarted
              let observationVisits = 0
              db.db.function('lineage_observation_visit', {}, (_rowid: unknown) => {
                observationVisits++
                return 1
              })
              let visits = 0
              db.db.function('lineage_bench_visit', {}, (_rowid: unknown) => {
                visits++
                return 1
              })
              const prepare = db.db.prepare.bind(db.db)
              const trace = vi
                .spyOn(db.db, 'prepare')
                .mockImplementation((query) =>
                  prepare(
                    query
                      .replaceAll(
                        'WHERE assignee_orca_session_id IS NOT NULL',
                        'WHERE assignee_orca_session_id IS NOT NULL AND lineage_bench_visit(rowid)'
                      )
                      .replace(
                        'WHERE dispatch_id IN',
                        'WHERE lineage_observation_visit(rowid) AND dispatch_id IN'
                      )
                  )
                )
              const start = performance.now()
              const output = projectionFor(db).buildByPaneKey()
              const buildMs = performance.now() - start
              const productionPrepareCalls = trace.mock.calls.length
              const activeSessionVerificationProbes = trace.mock.calls.filter(
                ([query]) =>
                  query.includes('rowid AS n') &&
                  query.includes('assignee_orca_session_id') &&
                  query.includes("AND status IN ('pending', 'dispatched')")
              ).length
              expect(activeSessionVerificationProbes).toBe(0)
              const plans = trace.mock.calls
                .filter(
                  ([query]) =>
                    query.includes('idx_dispatch_session_presentation') ||
                    query.includes('rowid AS n')
                )
                .map(([query]) =>
                  db.db
                    .prepare(`EXPLAIN QUERY PLAN ${query}`)
                    .all(
                      ...(query.includes('completed_at >= ?')
                        ? ['2026-10-26T00:00:00Z']
                        : ['orca_session_id:bench-0'])
                    )
                )
              expect(Object.keys(output ?? {})).toHaveLength(20)
              expect(visits).toBe(20)
              expect(observationVisits).toBe(attentionFacts)
              expect(JSON.stringify(plans)).not.toMatch(/SCAN dispatch_contexts/)
              console.log(
                'LINEAGE_BENCH_ENVIRONMENT_EVIDENCE',
                JSON.stringify({
                  host: hostname(),
                  node: process.version,
                  platform: process.platform,
                  arch: process.arch,
                  checkout: process.cwd(),
                  history,
                  nullAddress,
                  terminalHistory,
                  attentionFacts,
                  observationVisits,
                  indexHelperMs,
                  reopenWithIndexCreationMs,
                  buildMs,
                  candidateVisits: visits,
                  productionPrepareCalls,
                  diagnosticPrepareCalls: trace.mock.calls.length - productionPrepareCalls,
                  activeSessionVerificationProbes,
                  plans
                })
              )
              trace.mockRestore()
            } finally {
              db.close()
              rmSync(directory, { recursive: true, force: true })
            }
          }
        }
      }
    }
  }
)

it('reads reopened/backfilled assignments and committed clear facts from the already opened store before host installation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-lineage-contract-'))
  const root = sessionRecord(SESSION_X)
  const successor = COORDINATOR_CHAT
  await seedTestAgentSessionRecordStore(directory, {
    records: [
      {
        ...root,
        conversationCommand: {
          command: 'clear',
          runtimeFence: root.lease.runtimeFence,
          operationId: 'clear',
          callerKey: 'test',
          phase: 'committed',
          state: 'completed',
          replacementSessionId: successor
        }
      },
      sessionRecord(successor),
      sessionRecord(SESSION_Y)
    ],
    sessionTabs: [
      { tabId: 'reserved-successor', sessionId: successor },
      { tabId: 'reserved-worker', sessionId: SESSION_Y }
    ]
  })
  closeTestJournalHostDatabase(directory)
  const path = join(directory, 'orchestration.sqlite')
  let db = new OrchestrationDb(path)
  let opened = false
  try {
    const run = db.createRun({
      objective: 'cold public display',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: SESSION_X
    })
    const privateHandles: string[] = []
    const privatePanes: string[] = []
    for (const id of [SESSION_Y, successor]) {
      const handle = mintStructuredWorkerHandle()
      const pane = mintStructuredWorkerPaneKey(id)
      privateHandles.push(handle)
      privatePanes.push(pane)
      db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: 'persisted worker' }).id,
        assigneeHandle: handle,
        assigneePaneKey: pane,
        processIncarnation: structuredWorkerProcessIncarnation(id),
        creator: { kind: 'session', orcaSessionId: SESSION_X },
        maxDepth: 99
      })
    }
    db.db.exec('UPDATE dispatch_contexts SET assignee_orca_session_id = NULL')
    db.close()
    db = new OrchestrationDb(path)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    hostRef.current = null
    const before = runtime['agentOrchestrationProjection'].buildByPaneKey()
    expect(before?.[chatRow(SESSION_Y)]?.parentPaneKey).toBe(chatRow(SESSION_X))
    await openAgentSessionRecordStoreOnce({
      stateDirectory: directory,
      hostId: 'local',
      logger: recordingStructuredAgentSessionLogger().logger
    })
    opened = true
    const result = runtime['agentOrchestrationProjection'].buildByPaneKey()
    expect(result?.[chatRow(SESSION_Y)]?.parentPaneKey).toBe(chatRow(successor))
    expect(result?.[chatRow(successor)]?.parentPaneKey).toBeUndefined()
    for (const privateValue of [...privateHandles, ...privatePanes]) {
      expect(JSON.stringify(result)).not.toContain(privateValue)
    }
    for (const status of ['idle', 'working', 'attention'] as const) {
      runtime.onStructuredSessionStatusForMail({ sessionId: SESSION_Y, status })
      expect(
        runtime['agentOrchestrationProjection'].buildByPaneKey()?.[chatRow(SESSION_Y)]
          ?.parentPaneKey
      ).toBe(chatRow(successor))
    }
  } finally {
    if (opened) {
      ;(await releaseAgentSessionRecordStore())?.journalDatabase.close()
    }
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
