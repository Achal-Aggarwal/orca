import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../shared/agent-session-record.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { expect, it, vi } from 'vitest'
import {
  createReceivingAccountFixture,
  SELECTED_B
} from './structured-agent-session-receiving-account.test-support'
import { StructuredNativeResponses } from './structured-agent-session-native-responses'
import { structuredAgentSessionReceivingAccount } from './structured-agent-session-receiving-account'
const ordinary: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ordinary' }]
}
it.each([10, 100])(
  'indexes %i native results once and reads only changed journal rows thereafter',
  async (n) => {
    const f = await createReceivingAccountFixture()
    try {
      const started = performance.now()
      const messages = Array.from({ length: n }, () => f.finish(f.start()))
      for (const message of messages) {
        const next = await f.submit(f.body(message))
        await f.turn(next.clientMessageId, 'completed')
      }
      const visits = vi.spyOn(f.journal, 'visitItemsWithLinkage')
      const submissions = vi.spyOn(f.journal, 'submissions')
      const rows = vi.spyOn(f.journal, 'readSince')
      const keys = vi.spyOn(f.journal, 'canonicalItemId')
      const projection = new StructuredNativeResponses()
      expect(projection.read(f.journal).disposed.size).toBe(n)
      expect(visits).toHaveBeenCalledTimes(1)
      expect(submissions).toHaveBeenCalledTimes(1)
      keys.mockClear()
      for (let i = 0; i < n; i += 1) {
        projection.read(f.journal)
      }
      expect(keys).not.toHaveBeenCalled()
      expect(rows).not.toHaveBeenCalled()
      const next = await f.submit(ordinary, 'client')
      keys.mockClear()
      projection.read(f.journal)
      expect(keys.mock.calls.length).toBeLessThanOrEqual(8)
      expect(rows).toHaveBeenCalledTimes(1)
      expect(rows.mock.results[0]?.value).toMatchObject({ ok: true })
      expect(visits).toHaveBeenCalledTimes(1)
      expect(submissions).toHaveBeenCalledTimes(1)
      expect(next.clientMessageId).toBeTruthy()
      for (let i = 1; i <= n; i += 1) {
        await f.journal.appendTombstone(
          { provider: 'claude', sessionId: 'parent-provider', uuid: `turn-receiving-${i}` },
          { fence: 2 }
        )
      }
      projection.read(f.journal)
      expect(visits).toHaveBeenCalledTimes(2)
      expect(submissions).toHaveBeenCalledTimes(2)
      expect(rows).toHaveBeenCalledTimes(2)
      process.stdout.write(
        `receiving-account journal corpus=${n} initialVisits=1 initialSubmissionLists=1 unchangedReads=${n} incrementalReads=1 destructiveBatchRebuilds=1 elapsedMs=${(performance.now() - started).toFixed(3)}\n`
      )
    } finally {
      await f.dispose()
    }
  }
)

it.each([10, 100])(
  'bounds real native mailbox enumeration at %i results despite unrelated history',
  async (n) => {
    const f = await createReceivingAccountFixture()
    try {
      const began = performance.now()
      for (let i = 0; i < n; i += 1) {
        const next = await f.submit(f.body(f.finish(f.start())))
        await f.turn(next.clientMessageId, 'completed')
      }
      for (let i = 0; i < n * 10; i += 1) {
        f.db.createTask({ spec: 'unrelated corpus', runId: f.run.id })
      }
      const prepare = f.db.db.prepare.bind(f.db.db)
      let statements = 0
      let enumerated = 0
      const plans: string[] = []
      const spy = vi.spyOn(f.db.db, 'prepare').mockImplementation((sql) => {
        statements += 1
        const statement = prepare(sql)
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          for (const row of prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)) {
            if (typeof row.detail === 'string') {
              plans.push(row.detail)
            }
          }
          const rows = all(...args)
          enumerated += rows.length
          return rows
        })
        const get = statement.get.bind(statement)
        vi.spyOn(statement, 'get').mockImplementation((...args) => {
          for (const row of prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)) {
            if (typeof row.detail === 'string') {
              plans.push(row.detail)
            }
          }
          return get(...args)
        })
        return statement
      })
      const selected = await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)
      expect(selected.home).toEqual(SELECTED_B)
      expect(statements).toBeLessThanOrEqual(8)
      expect(enumerated).toBeLessThanOrEqual(n + 4)
      expect(plans.length).toBeGreaterThan(0)
      expect(
        plans.filter((detail) =>
          /\bSCAN (?:run|child|task|parent|messages|dispatch_contexts|agent_session_records)\b/.test(
            detail
          )
        )
      ).toEqual([])
      spy.mockRestore()
      process.stdout.write(
        `receiving-account native results=${n} unrelatedTasks=${n * 10} statements=${statements} enumerated=${enumerated} elapsedMs=${(performance.now() - began).toFixed(3)}\n`
      )
    } finally {
      await f.dispose()
    }
  }
)

it.each([10, 100])(
  'reads %i historical clear links through the real record index, independent of other chats',
  async (n) => {
    const f = await createReceivingAccountFixture()
    try {
      const began = performance.now()
      const predecessors = Array.from({ length: n }, (_, i) => ({
        ...agentSessionRecordFixture(
          agentSessionLeaseFixture({ sessionId: `clear-source-${i}`, runtimeFence: 2 })
        ),
        conversationCommand: {
          command: 'clear' as const,
          state: 'completed' as const,
          phase: 'committed' as const,
          runtimeFence: 2,
          callerKey: 'legacy-client',
          operationId: '1800000000000-00000000000000000000000000000003',
          replacementSessionId: i === n - 1 ? f.root : `clear-source-${i + 1}`
        }
      }))
      const unrelated = Array.from({ length: n * 10 }, (_, i) =>
        agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: `unrelated-chat-${i}` }))
      )
      await seedTestAgentSessionRecordStore(f.rig.root, {
        records: [f.record, ...predecessors, ...unrelated]
      })
      const store = await openTestAgentSessionRecordStore(f.rig.root)
      const db = openTestJournalHostDatabase(f.rig.root).db
      const prepare = db.prepare.bind(db)
      let reads = 0
      let enumerated = 0
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
        const statement = prepare(sql)
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          reads += 1
          const rows = all(...args)
          enumerated += rows.length
          const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)
          expect(
            plan.some(
              (row) =>
                typeof row.detail === 'string' &&
                row.detail.includes('idx_agent_session_clear_successor')
            )
          ).toBe(true)
          return rows
        })
        return statement
      })
      const lineage = store.lineageRecords(f.record)
      expect(lineage.map((record) => record.sessionId)).toEqual([
        ...predecessors.map((record) => record.sessionId),
        f.root
      ])
      expect(spy).toHaveBeenCalledTimes(1)
      expect(reads).toBe(n + 1)
      expect(enumerated).toBe(n)
      spy.mockRestore()
      process.stdout.write(
        `receiving-account clearLinks=${n} unrelatedChats=${n * 10} indexPrepares=1 lookups=${reads} enumerated=${enumerated} elapsedMs=${(performance.now() - began).toFixed(3)}\n`
      )
    } finally {
      await f.dispose()
    }
  }
)
