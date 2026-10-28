import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db'
import { buildCrewSnapshot, type CrewReadDependencies } from './crew-read-model'
import { CrewChanges } from './crew-changes'
import { subscribeCrew } from './crew-stream'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))
function fixture() {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const handles = new Map(
    ['coord', 'worker', 'helper', 'grandchild', 'peer', 'outbound'].map((name) => [
      `term_${name}`,
      `tab_${name}:aaaaaaaa-aaaa-4aaa-8aaa-${name.padEnd(12, 'a')}`
    ])
  )
  const deps: CrewReadDependencies = {
    db,
    retainedDbExists: true,
    hostKey: 'test-host',
    records: null,
    statuses: [],
    liveHandle: (handle) => handles.has(handle),
    handleForPane: (pane) => [...handles].find(([, value]) => value === pane)?.[0] ?? null,
    paneForHandle: (handle) => handles.get(handle) ?? null,
    name: (_identity, task) => task ?? 'Duplicate name'
  }
  const run = db.createRun({
    objective: 'Crew',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: handles.get('term_coord')!
  })
  const assign = (handle: string, creator = 'term_coord', title = 'Implement crew') => {
    const task = db.createTask({ runId: run.id, spec: title, taskTitle: title })
    db.updateTaskStatus(task.id, 'ready')
    return db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: handle,
      assigneePaneKey: handles.get(handle),
      creator: { kind: 'terminal', handle: creator, paneKey: handles.get(creator) },
      maxDepth: 10
    })
  }
  return { db, deps, run, assign }
}

describe('public crew read and stream', () => {
  it('derives direct roles and two-sided latest mail without consuming questions or leaking authority', async () => {
    const { db, deps, run, assign } = fixture()
    const worker = assign('term_worker')
    assign('orca_session_id:chat-root', 'term_coord', 'Chat task')
    const helper = assign('term_helper', 'term_worker', 'Help worker')
    assign('term_grandchild', 'term_helper', 'Help helper')
    const mail = db.insertMessage({
      runId: run.id,
      from: 'term_worker',
      to: 'term_coord',
      subject: 'Update',
      body: 'earlier'
    })
    const newest = db.insertMessage({
      runId: run.id,
      from: `run:${run.id}`,
      to: `dispatch:${worker.id}`,
      subject: 'Reply',
      body: 'latest'
    })
    db.insertMessage({ from: 'term_peer', to: 'term_coord', subject: 'Peer', body: 'inbound' })
    db.insertMessage({ from: 'term_coord', to: 'term_outbound', subject: 'Peer', body: 'outbound' })
    db.insertMessage({
      from: 'term_noise',
      to: 'term_coord',
      subject: 'heartbeat',
      type: 'heartbeat'
    })
    const asked = db.createQuestion({
      runId: run.id,
      dispatchId: worker.id,
      askerHandle: 'term_worker',
      question: 'Which option?'
    })
    const before = db.db.prepare('SELECT read FROM messages WHERE id = ?').get(mail.id)
    let snapshot = buildCrewSnapshot('term_coord', deps)
    expect(snapshot.sections.managing.map((row) => row.task?.title).sort()).toEqual([
      'Chat task',
      'Implement crew'
    ])
    expect(snapshot.sections.talkingWith.map((row) => row.latest?.direction).sort()).toEqual([
      'from',
      'to'
    ])
    expect(
      snapshot.sections.managing.find((row) => row.sendAddress === `dispatch:${worker.id}`)
        ?.pendingQuestion?.preview
    ).toBe('Which option?')
    expect(
      snapshot.sections.managing.find((row) => row.sendAddress === `dispatch:${worker.id}`)?.latest
        ?.sequence
    ).toBe(asked.message.sequence)
    expect(
      buildCrewSnapshot('term_worker', deps).sections.managing.map((row) => row.sendAddress)
    ).toEqual([`dispatch:${helper.id}`])
    expect(db.db.prepare('SELECT read FROM messages WHERE id = ?').get(mail.id)).toEqual(before)
    expect(JSON.stringify(snapshot)).not.toMatch(
      /structworker_|capability|paneKey|process_incarnation|launch_token/
    )
    db.answerQuestion({
      messageId: asked.message.id,
      runId: run.id,
      body: 'Use B',
      consumerGeneration: run.consumer_generation
    })
    snapshot = buildCrewSnapshot('term_coord', deps)
    expect(snapshot.sections.managing.some((row) => row.pendingQuestion)).toBe(false)
    expect(
      snapshot.sections.managing.find((row) => row.sendAddress === `dispatch:${worker.id}`)?.latest
        ?.direction
    ).toBe('to')
    expect(newest.sequence).toBeGreaterThan(mail.sequence)
    const gate = db.createGate({ taskId: worker.task_id, question: 'Ship?' })
    db.resolveGate(gate.id, 'Yes')
    expect(
      buildCrewSnapshot('term_coord', deps).sections.managing.find(
        (row) => row.sendAddress === `dispatch:${worker.id}`
      )?.task?.state
    ).toBe('ready')
  })

  it('keeps an empty subscription awake for first creation, coalesces changes and resolves cleared chat roots', async () => {
    const { db, deps, assign } = fixture()
    const wake = new CrewChanges()
    deps.db = null
    deps.retainedDbExists = false
    const frames: OrchestrationCrewFrame[] = []
    const stop = subscribeCrew(
      () => buildCrewSnapshot('term_coord', deps),
      wake.subscribe,
      (frame) => frames.push(frame)
    )
    expect(frames).toEqual([{ type: 'begin', status: 'ok' }, { type: 'complete' }])
    deps.retainedDbExists = true
    expect(buildCrewSnapshot('term_coord', deps).status).toBe('unknown')
    deps.db = db
    const unwatchDb = db.crewChanges.subscribe(wake.notify)
    assign('term_worker')
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(2)
    expect(frames.find((frame) => frame.type === 'rows')).toMatchObject({ section: 'managing' })
    wake.notify()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(2)
    stop()
    unwatchDb()
    const count = frames.length
    wake.notify()
    await Promise.resolve()
    expect(frames).toHaveLength(count)
    const root = agentSessionConversationView(
      agentSessionRecordFixture({
        sessionId: 'chat-root',
        conversationCommand: {
          command: 'clear',
          phase: 'committed',
          replacementSessionId: 'chat-next',
          operationId: 'clear-one'
        }
      })
    )
    const next = agentSessionConversationView(
      agentSessionRecordFixture({
        sessionId: 'chat-next',
        conversationName: 'Renamed',
        location: { workspaceId: 'folder-custom' }
      })
    )
    deps.records = {
      listRecords: () => [root, next],
      getRecord: (id) => (id === root.sessionId ? root : id === next.sessionId ? next : null)
    }
    assign('orca_session_id:chat-root')
    const chat = buildCrewSnapshot('orca_session_id:chat-next', deps)
    expect(chat.status).toBe('ok')
    expect(chat.sections.managedBy).toHaveLength(1)
    const child = buildCrewSnapshot('term_coord', deps).sections.managing.find(
      (row) => row.openTarget?.kind === 'chat'
    )
    expect(child?.openTarget).toEqual({
      kind: 'chat',
      sessionId: 'chat-next',
      worktreeId: 'folder-custom'
    })
  })
})

it('batches crew work as relationships scale and keeps skewed peers despite unrelated retained history', async () => {
  const { db, deps, run, assign } = fixture()
  for (let i = 0; i < 3; i++) {
    assign(`term_extra_${i}`)
  }
  let dependency = false
  const selection = db.listSessionDispatchesForPresentation.bind(db)
  const selectionSpy = vi
    .spyOn(db, 'listSessionDispatchesForPresentation')
    .mockImplementation((now) => {
      dependency = true
      try {
        return selection(now)
      } finally {
        dependency = false
      }
    })
  let queries = 0,
    materialized = 0
  const prepare = db.db.prepare.bind(db.db)
  const querySpy = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
    if (!dependency) {
      queries++
    }
    const statement = prepare(sql)
    const ownRead = !dependency
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (key === 'all') {
          return (...args: unknown[]) => {
            const rows = statement.all(...args)
            if (ownRead) {
              materialized += rows.length
            }
            return rows
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  })
  buildCrewSnapshot('term_coord', deps)
  const small = { queries, materialized }
  const readCount = selectionSpy.mock.calls.length
  expect(readCount).toBe(1)
  const frames: OrchestrationCrewFrame[] = []
  const stop = subscribeCrew(
    () => buildCrewSnapshot('term_coord', deps),
    db.crewChanges.subscribe,
    (frame) => frames.push(frame)
  )
  for (let i = 0; i < 100; i++) {
    const old = assign(`term_retained_${i}`)
    db.completeDispatch(old.id)
    db.db
      .prepare("UPDATE dispatch_contexts SET completed_at = '2000-01-01T00:00:00Z' WHERE id = ?")
      .run(old.id)
  }
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(1)
  queries = 0
  materialized = 0
  buildCrewSnapshot('term_coord', deps)
  expect({ queries, materialized }).toEqual(small)
  for (let i = 3; i < 30; i++) {
    assign(`term_extra_${i}`)
  }
  queries = 0
  materialized = 0
  const large = buildCrewSnapshot('term_coord', deps)
  expect(large.sections.managing).toHaveLength(30)
  expect(queries).toBe(small.queries)
  expect(materialized).toBeLessThanOrEqual(small.materialized * 10)
  querySpy.mockRestore()
  selectionSpy.mockRestore()
  for (let i = 0; i < 100; i++) {
    db.insertMessage({
      from: `run:${run.id}`,
      to: `term_mail_peer_${i}`,
      subject: 'Outbound only',
      body: String(i)
    })
  }
  const latest = db.insertMessage({
    from: 'term_mail_peer_0',
    to: 'term_coord',
    subject: 'Inbound',
    body: 'highest sequence across aliases'
  })
  const skewed = buildCrewSnapshot('term_coord', deps)
  expect(skewed.sections.talkingWith).toHaveLength(100)
  expect(
    skewed.sections.talkingWith.find((row) => row.latest?.preview === latest.body)?.latest
  ).toMatchObject({ sequence: latest.sequence, direction: 'from' })
  stop()
  vi.restoreAllMocks()
})
