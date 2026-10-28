import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { mailTestResources, observeMailSql } from './mail-handoff.test-fixture'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  ordinaryMailCreationId,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'

const resources = mailTestResources('ordinary-mail-discovery-')
function harness() {
  const db = resources.track(new OrchestrationDb(':memory:'))
  const receipts = new Set<string>()
  let capacity = true
  const waiters = new Set<OrchestrationMessageWaiter>()
  const host: StructuredMailboxPointerHost = {
    readCreation: vi.fn((id) => (receipts.has(id) ? 'accepted' : 'absent')),
    currentFence: () => 1,
    send: vi.fn(async (input) => {
      input.beforeRun()
      if (!capacity) {
        return { kind: 'held' }
      }
      receipts.add(input.operationId)
      return { kind: 'queued' }
    })
  }
  const bridge = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => waiters,
    resolveStructuredTarget: () => ({ sessionId: 'session', dispatchId: null }),
    getCliCommand: () => 'orca',
    senderName: () => null,
    host
  })
  const insert = (subject = 'report') =>
    db.insertMessage({ from: 'worker', to: 'consumer', subject })
  const idle = () => new Promise<void>((resolve) => setImmediate(resolve))
  return {
    db,
    host,
    bridge,
    receipts,
    waiters,
    insert,
    idle,
    capacity: (value: boolean) => {
      capacity = value
    }
  }
}

it('retries the same ordinary creation after capacity and waiter changes, without executing or batching reports', async () => {
  const h = harness()
  const a = h.insert('first'),
    b = h.insert('second')
  h.capacity(false)
  h.bridge.deliverForHandle('consumer')
  await h.idle()
  expect(h.db.getMessageById(a.id)?.delivered_at).toBeNull()
  expect(vi.mocked(h.host.send).mock.calls.map(([input]) => input.operationId)).toEqual([
    ordinaryMailCreationId(a),
    ordinaryMailCreationId(b)
  ])
  h.waiters.add({ typeFilter: undefined })
  h.capacity(true)
  h.bridge.onJournalActivity('session')
  await h.idle()
  expect(h.receipts.size).toBe(0)
  h.waiters.clear()
  h.bridge.deliverForHandle('consumer')
  await vi.waitFor(() => expect(h.receipts.size).toBe(2))
  expect(h.db.getMessageById(b.id)?.delivered_at).not.toBeNull()
  const calls = vi.mocked(h.host.send).mock.calls.slice(-2)
  expect(calls.map(([input]) => input.body.from?.orchestration?.messages)).toEqual([
    [{ messageId: a.id, runId: a.run_id, from: 'worker' }],
    [{ messageId: b.id, runId: b.run_id, from: 'worker' }]
  ])
  h.bridge.resetForDatabaseChange()
})

it.each([100, 1000])(
  'cold stamp reconciliation includes read rows and live queries do not walk N=%i delivered history',
  async (count) => {
    const h = harness()
    const rows = Array.from({ length: count }, () => h.insert())
    h.db.markAsDelivered(
      rows.map((row) => row.id),
      'consumer'
    )
    const lost = h.insert('accepted then independently checked')
    h.receipts.add(ordinaryMailCreationId(lost))
    h.db.markAsRead([lost.id])
    const observed: { sql: string; rows: number }[] = []
    const sql = observeMailSql(
      h.db.db,
      /SELECT id, sequence FROM messages|SELECT \* FROM messages.*|FROM messages\s+WHERE/s,
      'all',
      (call) => {
        observed.push({ sql: call.sql, rows: call.rows.length })
        if (call.sql.includes('ORDER BY sequence')) {
          expect(sql.explain(call.sql, call.args)).toContain('SEARCH')
        }
      }
    )
    h.bridge.deliverForHandle('consumer')
    await h.idle()
    expect(h.db.getMessageById(lost.id)?.delivered_at).not.toBeNull()
    expect(h.host.send).not.toHaveBeenCalled()
    expect(observed.reduce((sum, call) => sum + call.rows, 0)).toBe(1)
    observed.length = 0
    for (let n = 0; n < 10; n++) {
      h.bridge.onJournalActivity('session')
      await h.idle()
    }
    expect(observed.every((call) => call.rows === 0)).toBe(true)
    const fresh = h.insert('new local')
    h.bridge.deliverForHandle('consumer')
    await vi.waitFor(() => expect(h.receipts.has(ordinaryMailCreationId(fresh))).toBe(true))
    expect(observed.reduce((sum, call) => sum + call.rows, 0)).toBe(1)
    console.info('ordinary source work', {
      count,
      rows: observed,
      receipts: vi.mocked(h.host.readCreation).mock.calls
    })
    sql.trace.mockRestore()
    h.bridge.resetForDatabaseChange()
  }
)
