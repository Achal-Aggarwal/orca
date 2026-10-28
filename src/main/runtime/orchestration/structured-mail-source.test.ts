import { OrchestrationDb } from './db'
import { describe, expect, it, vi } from 'vitest'
import { readAgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { agentMessageHeading } from '../../../shared/agent-session/agent-message-presentation'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import type { SenderNameResolver } from './agent-message-sender'
import { orchestrationSenderName } from './orchestration-sender-name'
import * as canonical from './canonical-orca-session-id'
import * as parties from './orchestration-party'
import * as relations from './agent-message-relation'
import { structuredWorkerIdentities } from '../structured-worker-identity'
import * as lineage from './structured-session-lineage'
import { structuredMailSource, type MailSourceMessage } from './structured-mail-source'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

describe('who delivered mail is from', () => {
  it("names each sender once, without the pane key that would open its mailbox, and each message's own sender", () => {
    // No database: a terminal handle and a session address name their party by themselves.
    const source = structuredMailSource({
      db: null,
      mailboxHandle: 'run:r1',
      dispatchId: null,
      batch: [
        { id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null },
        {
          id: 'm2',
          from_handle: `orca_session_id:${SESSION}`,
          run_id: 'r2',
          type: 'status',
          payload: null
        },
        { id: 'm3', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }
      ],
      senderName: (party) => (party.terminalHandle === 'term_a' ? 'Build tab' : null)
    })
    expect(source).toEqual({
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
          name: 'Build tab'
        },
        {
          party: {
            address: `orca_session_id:${SESSION}`,
            terminalHandle: null,
            orcaSessionId: SESSION
          },
          name: null
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'run:r1',
        dispatchId: null,
        messages: [
          { messageId: 'm1', runId: 'r1', from: 'term_a' },
          { messageId: 'm2', runId: 'r2', from: `orca_session_id:${SESSION}` },
          { messageId: 'm3', runId: 'r1', from: 'term_a' }
        ]
      }
    })
  })

  it('bounds a snapshot name, and a naming failure costs only the name', () => {
    const named = (senderName: (party: unknown) => string | null) =>
      structuredMailSource({
        db: null,
        mailboxHandle: 'run:r1',
        dispatchId: null,
        batch: [{ id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }],
        senderName
      }).senders[0]?.name
    expect(named(() => `  Build\n${'x'.repeat(400)}`)).toHaveLength(200)
    expect(named(() => '   ')).toBeNull()
    expect(
      named(() => {
        throw new Error('records unavailable')
      })
    ).toBeNull()
  })
})

it('snapshots direct relations per sender, including mixed mail and completed reports', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'cards',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab:coord'
    })
    const assign = (handle: string, creator: string) =>
      db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: handle }).id,
        assigneeHandle: handle,
        assigneePaneKey: `tab:${handle}`,
        creator: { kind: 'terminal', handle: creator },
        maxDepth: 8
      })
    const worker = assign('term_worker', 'term_coord')
    const peer = assign('term_peer', 'term_coord')
    const child = assign('term_child', 'term_worker')
    const mail = (
      recipient: string,
      addresses: string[],
      dispatchId: string | null = null,
      report?: string
    ) =>
      structuredMailSource({
        db,
        mailboxHandle: recipient,
        dispatchId,
        senderName: () => 'Sender',
        batch: addresses.map<MailSourceMessage>((address, i) => ({
          id: `m${i}`,
          from_handle: address,
          run_id: run.id,
          type: report ? 'worker_done' : 'status',
          payload: report ? JSON.stringify({ dispatchId: report }) : null
        }))
      })
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBe('worker')
    expect(mail('term_worker', ['term_coord'], worker.id).senders[0].relation).toBe('coordinator')
    expect(mail('term_worker', ['term_peer'], worker.id).senders[0].relation).toBe('none')
    expect(mail('term_coord', ['term_child']).senders[0].relation).toBe('none')
    expect(mail('term_coord', ['unknown']).senders[0].relation).toBeUndefined()
    const ambiguous = assign('term_ambiguous', 'term_coord')
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
      .run('term_worker', ambiguous.id)
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBeUndefined()
    db.db
      .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
      .run(ambiguous.id)
    const conflicting = structuredMailSource({
      db,
      mailboxHandle: 'term_coord',
      dispatchId: null,
      senderName: () => 'Worker',
      batch: [
        { id: 'good', from_handle: 'term_worker', run_id: run.id, type: 'status', payload: null },
        {
          id: 'unknown',
          from_handle: 'term_worker',
          run_id: 'missing-run',
          type: 'status',
          payload: null
        }
      ]
    })
    expect(
      readAgentMessageSource(JSON.parse(JSON.stringify(conflicting)))!.senders[0].relation
    ).toBeUndefined()
    expect(mail('term_coord', ['dispatch:foreign']).senders[0].relation).toBeUndefined()
    expect(
      mail('term_worker', ['term_child', 'term_peer'], worker.id).senders.map(
        (sender) => sender.relation
      )
    ).toEqual(['worker', 'none'])
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(child.id)
    expect(mail('term_worker', ['term_child'], worker.id, child.id).senders[0].relation).toBe(
      'worker'
    )
    expect(mail('term_coord', ['term_peer'], null, child.id).senders[0].relation).toBeUndefined()
    const reload = (source: ReturnType<typeof mail>) =>
      readAgentMessageSource(JSON.parse(JSON.stringify(source)))!
    expect(agentMessageHeading(reload(mail('term_coord', ['term_worker'])))).toBe('worker')
    expect(agentMessageHeading(reload(mail('term_worker', ['term_coord'], worker.id)))).toBe(
      'coordinator'
    )
    expect(
      agentMessageHeading(reload(mail('term_worker', ['term_child', 'term_peer'], worker.id)))
    ).toBe('generic')
    for (const depth of [1, 2]) {
      db.db
        .prepare(
          'UPDATE dispatch_contexts SET creator_handle = NULL, creator_orca_session_id = NULL, creator_dispatch_id = NULL, depth = ? WHERE id = ?'
        )
        .run(depth, worker.id)
      expect(reload(mail('term_coord', ['term_worker'])).senders[0].relation).toBeUndefined()
    }
    db.db
      .prepare('UPDATE dispatch_contexts SET creator_dispatch_id = ? WHERE id = ?')
      .run(peer.id, worker.id)
    expect(mail('term_peer', ['term_worker'], peer.id).senders[0].relation).toBe('worker')
    db.db
      .prepare('UPDATE dispatch_contexts SET creator_handle = ? WHERE id = ?')
      .run('term_coord', worker.id)
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'ssh', targetId: 'elsewhere' }), worker.id)
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBeUndefined()
  } finally {
    db.close()
  }
})

it.each([
  [5, 1000, false],
  [50, 10000, false],
  [5, 1000, true],
  [50, 10000, true]
] as const)(
  'counts complete notice acquisition at B=%i S=%i distinct=%s',
  (batchSize, sessionCount, distinct) => {
    const db = new OrchestrationDb(':memory:')
    const coordinator = testOrcaSessionId('relation-coordinator')
    const sessions = Array.from({ length: batchSize }, (_, i) =>
      testOrcaSessionId(`relation-worker-${i}`)
    )
    const base = agentSessionConversationView(
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: sessions[0] }))
    )
    const records: (typeof base)[] = Array.from({ length: sessionCount }, (_, i) => ({
      ...base,
      sessionId:
        i === batchSize ? coordinator : (sessions[i] ?? testOrcaSessionId(`relation-${i}`)),
      conversationName: `Conversation ${i}`
    }))
    const bySession = new Map(records.map((record) => [record.sessionId, record]))
    let scanVisits = 0,
      canonicalClears = 0,
      canonicalLinks = 0,
      forwardClears = 0,
      forwardLinks = 0,
      canonicalDepth = 0,
      phase: 'sender' | 'relation' = 'sender',
      partyDepth = 0
    const calls = { sender: 0, recipient: 0, comparison: 0 }
    const scanned = new Proxy(records, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          scanVisits++
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
        return target[key as keyof typeof target]
      }
    })
    const listRecords = vi.fn(() => scanned)
    const getRecord = vi.fn((id: string) => {
      const record = bySession.get(id)
      return record
        ? new Proxy(record, {
            get(target, key) {
              if (key === 'conversationCommand') {
                const command = target.conversationCommand
                forwardClears++
                forwardLinks +=
                  command?.command === 'clear' &&
                  command.phase === 'committed' &&
                  command.replacementSessionId
                    ? 1
                    : 0
                return command
              }
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
              return target[key as keyof typeof target]
            }
          })
        : null
    })
    const reader = { listRecords, getRecord }
    vi.spyOn(lineage, 'readAgentSessionRecordStore').mockReturnValue(reader)
    const clearedInto = lineage.clearedInto
    vi.spyOn(lineage, 'clearedInto').mockImplementation((record) => {
      canonicalClears++
      const next = clearedInto(record)
      canonicalLinks += next ? 1 : 0
      return next
    })
    const canonicalize = canonical.canonicalOrcaSessionId
    const canonicalCalls = vi
      .spyOn(canonical, 'canonicalOrcaSessionId')
      .mockImplementation((...args) => {
        calls[phase === 'sender' ? 'sender' : partyDepth ? 'recipient' : 'comparison']++
        canonicalDepth++
        try {
          return canonicalize(...args)
        } finally {
          canonicalDepth--
        }
      })
    const party = parties.resolveOrchestrationParty
    const partyCalls = vi
      .spyOn(parties, 'resolveOrchestrationParty')
      .mockImplementation((...args) => {
        partyDepth++
        try {
          return party(...args)
        } finally {
          partyDepth--
        }
      })
    const relation = relations.agentMessageRelation
    const relationCalls = vi
      .spyOn(relations, 'agentMessageRelation')
      .mockImplementation((...args) => {
        phase = 'relation'
        try {
          return relation(...args)
        } finally {
          phase = 'sender'
        }
      })
    const registry = vi.spyOn(structuredWorkerIdentities, 'getBySessionId')
    const handleRegistry = vi.spyOn(structuredWorkerIdentities, 'get')
    try {
      const run = db.createRun({
        objective: 'cost',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: coordinator
      })
      const dispatches = sessions.map((session) =>
        db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'work' }).id,
          assigneeHandle: `orca_session_id:${session}`,
          creator: { kind: 'session', orcaSessionId: coordinator },
          maxDepth: 8
        })
      )
      const getRun = vi.spyOn(db, 'getRun')
      const byId = db.getDispatchContextById.bind(db)
      let reportedCandidateRows = 0
      const dispatchById = vi.spyOn(db, 'getDispatchContextById').mockImplementation((...args) => {
        const row = byId(...args)
        reportedCandidateRows += row ? 1 : 0
        return row
      })
      const workerRows = vi.spyOn(db, 'getWorkerTerminalResourceByProcessIncarnation')
      const workerHandles = vi.spyOn(db, 'getWorkerTerminalResourceByHandle')
      const nameDispatch = vi.spyOn(db, 'getActiveDispatchForTerminal'),
        tasks = vi.spyOn(db, 'getTask')
      const candidates = db.getActiveDispatchMailboxOwners.bind(db)
      let candidateRows = 0
      const candidateCalls = vi
        .spyOn(db, 'getActiveDispatchMailboxOwners')
        .mockImplementation((...args) => {
          const result = candidates(...args)
          candidateRows += result.length
          return result
        })
      const statements = vi.spyOn(db.db, 'prepare')
      const nameTab = vi.fn(() => null),
        terminal = vi.fn(() => null)
      const senderName = vi.fn<SenderNameResolver>((sender, report) =>
        orchestrationSenderName(
          sender,
          {
            db,
            records: reader,
            chatTab: nameTab,
            terminal,
            generatedTitlesEnabled: true
          },
          report
        )
      )
      let batchVisits = 0,
        payloadParses = 0,
        payloadBytes = 0
      const batch = new Proxy(
        Array.from({ length: batchSize }, (_, i) => ({
          id: `m${i}`,
          from_handle: `orca_session_id:${sessions[distinct ? i : 0]}`,
          run_id: run.id,
          type: 'worker_done',
          payload: JSON.stringify({ dispatchId: dispatches[distinct ? i : 0].id })
        })),
        {
          get(target, key) {
            if (typeof key === 'string' && /^\d+$/.test(key)) {
              batchVisits++
            }
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
            return target[key as keyof typeof target]
          }
        }
      )
      const payloads = new Set(batch.map((message) => message.payload))
      const parse = JSON.parse
      vi.spyOn(JSON, 'parse').mockImplementation((value, ...rest) => {
        if (payloads.has(value)) {
          payloadParses++
          payloadBytes += value.length
        }
        return parse(value, ...rest)
      })
      const groups = distinct ? batchSize : 1
      const notice = () =>
        structuredMailSource({
          db,
          mailboxHandle: `orca_session_id:${coordinator}`,
          dispatchId: null,
          batch,
          senderName
        })
      const reset = () => {
        batchVisits = 0
        payloadParses = 0
        payloadBytes = 0
        scanVisits = 0
        canonicalClears = 0
        canonicalLinks = 0
        forwardClears = 0
        forwardLinks = 0
        candidateRows = 0
        reportedCandidateRows = 0
        calls.sender = 0
        calls.recipient = 0
        calls.comparison = 0
        for (const spy of [
          canonicalCalls,
          relationCalls,
          partyCalls,
          listRecords,
          getRecord,
          getRun,
          dispatchById,
          candidateCalls,
          registry,
          handleRegistry,
          workerRows,
          workerHandles,
          senderName,
          nameTab,
          terminal,
          nameDispatch,
          tasks,
          statements
        ]) {
          spy.mockClear()
        }
      }
      reset()
      const source = notice()
      expect(agentMessageHeading(readAgentMessageSource(parse(JSON.stringify(source)))!)).toBe(
        'worker'
      )
      expect(
        source.orchestration?.message === 'mail-notice' && source.orchestration.messages
      ).toHaveLength(batchSize)
      expect(source.senders).toHaveLength(groups)
      expect(senderName).toHaveBeenCalledTimes(groups)
      expect(nameTab).toHaveBeenCalledTimes(groups)
      expect(getRecord).toHaveBeenCalledTimes(groups) // Actual name lineage, separate from full canonical scans.
      expect(terminal).not.toHaveBeenCalled()
      expect(relationCalls).toHaveBeenCalledTimes(groups)
      expect(getRun).toHaveBeenCalledTimes(groups)
      expect(dispatchById).toHaveBeenCalledTimes(groups)
      expect(reportedCandidateRows).toBe(groups) // Every explicit report returns one real candidate.
      expect(candidateCalls).toHaveBeenCalledTimes(groups)
      expect(candidateRows).toBe(0) // Coordinator has no worker Dispatch in this corpus.
      expect(batchVisits).toBe(batchSize * 2) // Grouping and provenance serialization, no per-sender filter.
      expect(payloadParses).toBe(batchSize)
      expect(payloadBytes).toBe(batch.reduce((sum, message) => sum + message.payload.length, 0))
      expect(partyCalls).toHaveBeenCalledTimes(groups * 2) // Sender plus actual recipient, neither mocked away.
      expect(calls).toEqual({ sender: groups, recipient: groups, comparison: groups * 6 })
      expect(canonicalCalls).toHaveBeenCalledTimes(groups * 8)
      expect(listRecords).toHaveBeenCalledTimes(canonicalCalls.mock.calls.length)
      expect(scanVisits).toBe(listRecords.mock.calls.length * sessionCount)
      expect(canonicalClears).toBe(scanVisits) // Imported canonical checks only; name lookup calls its lexical function.
      expect(canonicalLinks).toBe(0)
      expect(forwardClears).toBe(groups) // Actual command reads in name lookup, one per returned direct-get record.
      expect(forwardLinks).toBe(0)
      for (const [index, [id]] of canonicalCalls.mock.calls.entries()) {
        expect(canonicalCalls.mock.results[index]).toMatchObject({ type: 'return', value: id })
      }
      // canonical-orca-session-id:16-31 builds no predecessor edges here: K initial Map.gets, no loop steps.
      expect(canonicalCalls.mock.calls.length).toBe(groups * 8)
      expect(canonicalDepth).toBe(0)
      expect(registry).toHaveBeenCalledTimes(groups * 2)
      expect(workerRows).toHaveBeenCalledTimes(groups * 2)
      expect(handleRegistry).not.toHaveBeenCalled()
      expect(workerHandles).not.toHaveBeenCalled()
      expect(nameDispatch).not.toHaveBeenCalled()
      expect(tasks).not.toHaveBeenCalled()
      // Every SQL query in this corpus is one of these actual acquisition/candidate paths.
      expect(statements.mock.calls.length).toBe(
        getRun.mock.calls.length +
          dispatchById.mock.calls.length +
          candidateCalls.mock.calls.length +
          workerRows.mock.calls.length +
          registry.mock.calls.length
      )
      const first = {
        scans: listRecords.mock.calls.length,
        visits: scanVisits,
        gets: getRecord.mock.calls.length
      }
      reset()
      notice()
      expect({
        scans: listRecords.mock.calls.length,
        visits: scanVisits,
        gets: getRecord.mock.calls.length
      }).toEqual(first)
      // New notice sees fresh explicit evidence; no cross-notice negative cache.
      db.db
        .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = NULL WHERE id = ?')
        .run(dispatches[0].id)
      expect(notice().senders[0].relation).toBeUndefined()
      db.db
        .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = ? WHERE id = ?')
        .run(coordinator, dispatches[0].id)
      expect(notice().senders[0].relation).toBe('worker')
      // Committed /clear predecessor scans and forward name traversal remain separate populations.
      const successor = testOrcaSessionId('relation-worker-after-clear')
      const clear = agentSessionConversationView({
        ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: sessions[0] })),
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          phase: 'committed',
          operationId: 'clear',
          callerKey: 'caller',
          replacementSessionId: successor
        }
      })
      records[0] = clear
      bySession.set(sessions[0], clear)
      bySession.set(successor, { ...base, sessionId: successor })
      reset()
      const afterClear = structuredMailSource({
        db,
        mailboxHandle: `orca_session_id:${coordinator}`,
        dispatchId: null,
        senderName,
        batch: [{ ...batch[0], from_handle: `orca_session_id:${successor}` }]
      })
      expect(afterClear.senders[0].party.orcaSessionId).toBe(sessions[0])
      expect(afterClear.senders[0].relation).toBe('worker')
      expect(getRecord).toHaveBeenCalledTimes(2) // Forward name chain root -> successor.
      expect(scanVisits).toBe(listRecords.mock.calls.length * sessionCount)
      expect(canonicalClears).toBe(scanVisits)
      expect(canonicalLinks).toBe(listRecords.mock.calls.length) // One committed predecessor per full scan.
      expect(getRecord.mock.calls.map(([id]) => id)).toEqual([sessions[0], successor])
      expect(forwardClears).toBe(2) // Lexical forward checks: root -> successor, then no successor.
      expect(forwardLinks).toBe(1)
      let reverseEdges = 0
      for (const [index, [id]] of canonicalCalls.mock.calls.entries()) {
        const root = id === successor ? sessions[0] : id
        expect(canonicalCalls.mock.results[index]).toMatchObject({ type: 'return', value: root })
        reverseEdges += id === successor ? 1 : 0
      }
      // One stored edge: source-composed reverse loop steps = successor inputs, Map.gets = K + steps.
      expect(reverseEdges).toBe(1)
      expect(canonicalCalls.mock.calls.length + reverseEdges).toBe(
        listRecords.mock.calls.length + 1
      )
      const terminalRun = db.createRun({
        objective: 'terminal',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: null
      })
      db.createDispatchContext({
        taskId: db.createTask({ runId: terminalRun.id, spec: 'terminal' }).id,
        assigneeHandle: 'term_worker',
        creator: { kind: 'terminal', handle: 'term_coord' },
        maxDepth: 8
      })
      reset()
      const terminalOnly = structuredMailSource({
        db,
        mailboxHandle: `run:${terminalRun.id}`,
        dispatchId: null,
        senderName,
        batch: Array.from({ length: batchSize }, (_, i) => ({
          id: `t${i}`,
          from_handle: 'term_worker',
          run_id: terminalRun.id,
          type: 'status',
          payload: null
        }))
      })
      expect(terminalOnly.senders[0].relation).toBe('worker')
      expect(listRecords).not.toHaveBeenCalled()
      expect(getRecord).not.toHaveBeenCalled()
      expect(canonicalCalls).not.toHaveBeenCalled()
      expect(scanVisits).toBe(0)
      expect(canonicalClears).toBe(0)
      expect(canonicalLinks).toBe(0)
      expect(forwardClears).toBe(0)
      expect(forwardLinks).toBe(0)
      expect(terminal).toHaveBeenCalledTimes(1)
      expect(nameDispatch).toHaveBeenCalledTimes(1)
      expect(tasks).toHaveBeenCalledTimes(1)
      // This zero-scan assertion is specifically a terminal with no structured-worker mapping.
      expect(registry).not.toHaveBeenCalled()
      expect(workerHandles).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      db.close()
    }
  }
)

it('keeps every Run/report disagreement, first nonempty report name, and cached unknown only within this notice', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'mail',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const worker = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'work' }).id,
      assigneeHandle: 'term_worker',
      creator: { kind: 'terminal', handle: 'term_coord' },
      maxDepth: 8
    })
    const senderName = vi.fn<SenderNameResolver>(() => 'Worker')
    const evaluate = vi.spyOn(relations, 'agentMessageRelation')
    const base = {
      from_handle: 'term_worker',
      run_id: run.id,
      type: 'worker_done',
      payload: JSON.stringify({ dispatchId: worker.id })
    }
    const notice = (batch: MailSourceMessage[]) =>
      structuredMailSource({ db, mailboxHandle: 'term_coord', dispatchId: null, batch, senderName })
    const good = { ...base, id: 'good' }
    for (const other of [
      { ...good, id: 'other-run', run_id: 'missing' },
      { ...good, id: 'bad', payload: '{' },
      { ...good, id: 'empty', payload: '{"dispatchId":""}' },
      { ...good, id: 'wrong', payload: '{"dispatchId":"missing"}' }
    ]) {
      evaluate.mockClear()
      senderName.mockClear()
      const result = notice([other, good, good])
      expect(result.senders[0].relation).toBeUndefined()
      expect(
        result.orchestration?.message === 'mail-notice' && result.orchestration.messages
      ).toHaveLength(3)
      expect(senderName).toHaveBeenCalledTimes(1)
      expect(senderName.mock.calls[0][1]).toBe(other.id === 'wrong' ? 'missing' : worker.id)
      expect(evaluate).toHaveBeenCalledTimes(other.id === 'bad' || other.id === 'empty' ? 1 : 2)
    }
    evaluate.mockClear()
    const missing = { ...good, run_id: 'missing' }
    expect(notice([missing, missing]).senders[0].relation).toBeUndefined()
    expect(evaluate).toHaveBeenCalledTimes(1) // Map membership caches undefined too.
    expect(notice([{ ...good, type: 'status', payload: null }, good]).senders[0].relation).toBe(
      'worker'
    )
  } finally {
    vi.restoreAllMocks()
    db.close()
  }
})
