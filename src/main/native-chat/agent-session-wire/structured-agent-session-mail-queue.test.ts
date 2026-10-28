import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { OrchestrationStructuredMailboxPointerDelivery } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { ordinaryMailCreationId } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { sendAgentTurn } from '../../runtime/orchestration/send-agent-turn'
import { structuredMailSource } from '../../runtime/orchestration/structured-mail-source'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { insertCommandReceiptIfAbsent } from '../agent-session-journal/command-receipt-table'
import { observeMailSql } from '../../runtime/orchestration/mail-handoff.test-fixture'
import { captureSessionMailAtStop } from '../../runtime/orchestration/session-mail-stop-inventory'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import {
  QUEUED_RIG_CALLER,
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  hostTestOperationId,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'
import {
  readQueuePublication,
  structuredQueueSendGate
} from './structured-agent-session-queued-publication'

let rig: QueuedMessageTestRig
let db: OrchestrationDb
let bridge: OrchestrationStructuredMailboxPointerDelivery<never>
const clock = createStructuredSessionObservationClock(() => rig.host, SESSION)
beforeEach(async () => {
  clock.start()
  rig = await createQueuedMessageTestRig({ restartable: true })
  db = new OrchestrationDb(':memory:')
  setStructuredAgentSessionHost(rig.host)
  bridge = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: (address) =>
      address === 'consumer' ? { sessionId: SESSION, dispatchId: null } : null,
    getCliCommand: () => 'orca',
    senderName: () => null,
    host: createStructuredMailboxPointerHost()
  })
  installSourceCapture()
})
function installSourceCapture() {
  rig.host.deps.captureSessionMail = () =>
    captureSessionMailAtStop(db, () => {
      throw new Error('source retirement')
    })
}
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  bridge.resetForDatabaseChange()
  await clock.restoreBeforeCleanup(async () => {
    await rig.dispose()
    db.close()
  })
})
function journal() {
  const value = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!value) {
    throw new Error('journal missing')
  }
  return value
}
async function report(subject: string, notify = true) {
  const row = db.insertMessage({ from: 'worker', to: 'consumer', subject })
  if (notify) {
    bridge.deliverForHandle('consumer')
  }
  return row
}
async function card(messageId: string) {
  const message = db.getMessageById(messageId)
  if (!message) {
    throw new Error('source missing')
  }
  const id = ordinaryMailCreationId(message)
  await eventually(() => {
    expect(db.getMessageById(messageId)?.delivered_at).not.toBeNull()
    expect(journal().queuedMessages.get(id)).toBeTruthy()
  })
  return id
}

async function complete(id: string) {
  await rig.settleAccepted(id, id)
  await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: `full-${id}`, ordinal: 0 },
    {
      kind: 'turn',
      turnId: `full-${id}`,
      state: 'completed',
      outcome: 'success',
      startedAt: Date.now(),
      completedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(id)
    },
    {
      fence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

it('enqueues busy reports before effects and runs the oldest attributed full turn, including an idle arrival', async () => {
  const working = await rig.workingSend()
  const approval = await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
    {
      kind: 'approval',
      title: 'Continue?',
      detail: null,
      options: [{ id: 'yes', label: 'Continue' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    {
      fence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  const first = await report('first')
  const second = await report('second')
  const a = await card(first.id),
    b = await card(second.id)
  expect(journal().queuedMessages.get(a)?.state).toBe('waiting')
  expect(await rig.handoff(a)).toBeUndefined()
  expect(rig.dispatch).toHaveBeenCalledOnce()
  const answer = { itemId: approval.itemId, expectedRevision: approval.revision, optionId: 'yes' }
  expect(
    await rig.host.respondToPrompt(QUEUED_RIG_CALLER, {
      ...answer,
      kind: 'approval',
      envelope: rig.envelope(answer, 'agentSession.respondTo:approval', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  await clock.observe(100)
  expect(await rig.handoff(a)).toBeUndefined()
  await complete(working)
  await eventually(async () =>
    expect(await rig.handoff(a)).toMatchObject({ source: { kind: 'agent' }, origin: 'host' })
  )
  const attempt = await rig.handoffId(a)
  await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: `full-${attempt}`, ordinal: 0 },
    {
      kind: 'turn',
      turnId: `full-${attempt}`,
      state: 'running',
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(attempt)
    },
    {
      fence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  await rig.settleAccepted(attempt, 'first-echo')
  await clock.observe(100)
  expect(await rig.handoff(b)).toBeUndefined()
  await complete(attempt)
  await eventually(async () =>
    expect(await rig.handoff(b)).toMatchObject({ source: { kind: 'agent' } })
  )
  await complete(await rig.handoffId(b))
  const idle = await report('idle')
  const q = await card(idle.id)
  await eventually(async () =>
    expect(await rig.handoff(q)).toMatchObject({ source: { kind: 'agent' } })
  )
  expect(rig.cancelTurn).not.toHaveBeenCalled()
  expect(journal().queuedMessages.get(q)?.body.from?.orchestration).toMatchObject({
    messages: [{ messageId: idle.id }]
  })
})

it('fresh mail passes a stopped personal queue and old admitted/missed mail without releasing either; explicit worker Send keeps attribution', async () => {
  const working = await rig.workingSend()
  const person = rig.send('personal waiting', 'queue-if-active')
  expect(await person.result).toMatchObject({ ok: true, value: { queued: {} } })
  const old = await report('old admitted'),
    missed = await report('old missed', false)
  const oldId = await card(old.id)
  expect(await rig.stop()).toMatchObject({ ok: true })
  const fresh = await report('fresh')
  const freshId = await card(fresh.id),
    missedId = await card(missed.id)
  await eventually(async () =>
    expect(await rig.handoff(freshId)).toMatchObject({ source: { kind: 'agent' } })
  )
  expect(await rig.handoff(person.id)).toBeUndefined()
  expect(await rig.handoff(oldId)).toBeUndefined()
  expect(await rig.handoff(missedId)).toBeUndefined()
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  const freshAttempt = await rig.handoffId(freshId)
  await rig.settleAccepted(freshAttempt, 'fresh-running')
  await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'fresh-running', ordinal: 0 },
    {
      kind: 'turn',
      turnId: 'fresh-running',
      state: 'running',
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(freshAttempt)
    },
    {
      fence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  const intent = journal().mailBoundary()
  await rig.host.close(SESSION, 'evict')
  await rig.settleAccepted(working, 'late-original-acceptance')
  await clock.observe(200)
  await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(journal().mailBoundary()).toEqual(intent)
  expect(await rig.handoff(person.id)).toBeUndefined()
  expect(await rig.handoff(oldId)).toBeUndefined()
  expect(await rig.handoff(missedId)).toBeUndefined()
  const notify = vi.fn().mockImplementationOnce(() => {
    throw new Error('optional source callback unavailable')
  })
  rig.host.deps.onSessionMailActivity = notify
  expect(await rig.sendNow(oldId)).toMatchObject({
    ok: true,
    value: { submission: { source: { kind: 'agent' }, origin: 'client' } }
  })
  expect(notify).toHaveBeenCalled()
  expect(journal().mailBoundary()?.status).toBe('released')
  expect(await rig.handoff(person.id)).toBeUndefined()
  const attempt = await rig.handoffId(oldId)
  await complete(attempt)
  await eventually(async () => expect(await rig.handoff(person.id)).toBeDefined())
  expect((await rig.submission(working))?.source?.kind).toBe('user')
})

it.each([100, 1000])(
  'does not rescan a paused N=%i prefix on token publication and retires obsolete source interest',
  async (count) => {
    const working = await rig.workingSend()
    const journalDb = openTestJournalHostDatabase(rig.root)
    journalDb.transaction((connection) => {
      for (let n = 0; n < count; n++) {
        insertCommandReceiptIfAbsent(
          connection,
          { kind: 'global' },
          {
            operationId: `retained-receipt-${n}`,
            sessionId: SESSION,
            callerKey: 'old-client',
            method: 'agentSession.send',
            fingerprint: 'old',
            status: 'accepted',
            acceptedAt: 1,
            result: { kind: 'queued-draft', messageId: `retained-history-${n}` }
          }
        )
      }
    })
    const reads: { sql: string; args: unknown; rows: number }[] = []
    const receipts = observeMailSql(
      journalDb.db,
      /FROM agent_session_command_receipts/,
      'all',
      (call) => {
        reads.push({ sql: call.sql, args: call.args, rows: call.rows.length })
        expect(call.sql).toContain('operation_id = ?')
        expect(receipts.explain(call.sql, call.args)).toContain('SEARCH')
        expect(call.rows.length).toBeLessThanOrEqual(1)
      }
    )
    const parse = vi.spyOn(JSON, 'parse')
    const liveBody = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'live person' }]
    }
    const liveFields = { body: liveBody, delivery: 'queue-if-active' as const }
    const live = {
      ...liveFields,
      userSend: true as const,
      envelope: rig.envelope(liveFields, 'agentSession.send', hostTestOperationId())
    }
    expect(await rig.host.send(QUEUED_RIG_CALLER, live)).toMatchObject({ ok: true })
    expect(await rig.host.send(QUEUED_RIG_CALLER, live)).toMatchObject({ ok: true, replayed: true })
    await rig.stop()
    expect(await rig.resume()).toMatchObject({ ok: true })
    await rig.restartHostProcess()
    installSourceCapture()
    setStructuredAgentSessionHost(rig.host)
    await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(parse.mock.calls.filter(([text]) => text.includes('retained-history-'))).toHaveLength(0)
    console.info('ordinary live Send/replay/Resume/cold receipt work', { count, reads })
    parse.mockRestore()
    receipts.trace.mockRestore()
    for (let i = 0; i < count; i++) {
      await journal().queuedMessages.insert({
        messageId: `personal-${i}`,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'waiting' }] }
      })
    }
    await rig.stop()
    const fresh = await report('fresh')
    const id = await card(fresh.id)
    await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
    const host = rig.host
    const gate = structuredQueueSendGate(
      { store: rig.store, sessions: host.collaboratorsForTests().sessions },
      SESSION
    )
    const before = readQueuePublication(journal(), gate)
    const list = vi.spyOn(journal().queuedMessages, 'list')
    const inventory = vi.spyOn(db.db, 'prepare')
    for (let i = 0; i < 10; i++) {
      expect(readQueuePublication(journal(), gate)).toBe(before)
    }
    expect(list).not.toHaveBeenCalled()
    expect(inventory).not.toHaveBeenCalled()
    bridge.forgetSession(SESSION)
    bridge.onJournalActivity(SESSION)
    expect(inventory).not.toHaveBeenCalled()
    expect((await rig.submission(working))?.source?.kind).toBe('user')
  }
)

it('recovers only the original ordinary creation after a lost delivered stamp, edits, Move, Delete, epoch retirement, read and resetTasks', async () => {
  await rig.workingSend()
  const stamp = vi.spyOn(db, 'markAsDelivered').mockImplementation(() => {
    throw new Error('lost source stamp')
  })
  const source = await report('original report')
  const id = ordinaryMailCreationId(source)
  await eventually(() =>
    expect(rig.store.readCommandReceipt({ kind: 'global' }, id)).toMatchObject({
      verdict: 'readable',
      receipt: { status: 'accepted', result: { kind: 'queued-draft', messageId: id } }
    })
  )
  const original = journal().queuedMessages.get(id)
  if (!original) {
    throw new Error('ordinary card missing after commit')
  }
  const update = {
    messageId: id,
    expectedBodyFingerprint: original.fingerprint,
    text: 'person edited report'
  }
  expect(
    await rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(update, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
      ...update
    })
  ).toMatchObject({ ok: true })
  expect(journal().queuedMessages.get(id)?.body.from).toEqual(original.body.from)
  const personal = rig.send('personal next', 'queue-if-active')
  await personal.result
  const move = { messageId: id, afterMessageId: personal.id }
  expect(
    await rig.host.queuedMessageMove(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(move, 'agentSession.queuedMessageMove', hostTestOperationId()),
      ...move
    })
  ).toMatchObject({ ok: true })
  expect(await rig.deleteQueued(id)).toMatchObject({ ok: true })
  await journal().replaceEpochItems('handle_forked', 1, [])
  db.markAsRead([source.id])
  db.resetTasks()
  db.db
    .prepare('UPDATE messages SET subject = ? WHERE id = ?')
    .run('changed source presentation', source.id)
  await rig.restartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  stamp.mockRestore()
  bridge.resetForDatabaseChange()
  const sends = vi.spyOn(rig.host, 'send')
  bridge.deliverForHandle('consumer')
  await eventually(() => expect(db.getMessageById(source.id)?.delivered_at).not.toBeNull())
  expect(sends).not.toHaveBeenCalled()
  await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(journal().queuedMessages.get(id)?.state).not.toBe('waiting')
  expect(rig.store.readCommandReceipt({ kind: 'global' }, id)).toMatchObject({
    verdict: 'readable'
  })
})

it('uses a real queue Delete publication to retry the same source creation after ordinary byte pressure', async () => {
  await rig.workingSend()
  const personal = []
  for (let n = 0; n < 4; n++) {
    const send = rig.send('p'.repeat(200_000), 'queue-if-active')
    expect(await send.result).toMatchObject({ ok: true, value: { queued: {} } })
    personal.push(send.id)
  }
  rig.host.deps.onSessionMailActivity = (id) => bridge.onJournalActivity(id)
  const sends = vi.spyOn(rig.host, 'send')
  const source = await report('waiting for ordinary queue space')
  const id = ordinaryMailCreationId(source)
  await eventually(() => expect(sends).toHaveBeenCalled())
  await clock.observe(100)
  expect(db.getMessageById(source.id)?.delivered_at).toBeNull()
  expect(rig.store.readCommandReceipt({ kind: 'global' }, id).verdict).toBe('absent')
  expect(await rig.deleteQueued(personal[0])).toMatchObject({ ok: true })
  await card(source.id)
  expect(sends.mock.calls.every(([, input]) => input.envelope.clientOperationId === id)).toBe(true)
  expect(journal().queuedMessages.get(id)?.state).toBe('waiting')
})

it('reconciles a saved random batch through its original ordinary receipt after Delete and restart, without recreating either report', async () => {
  await rig.workingSend()
  const a = await report('old batch first', false),
    b = await report('old batch second', false)
  const oldId = hostTestOperationId()
  const source = structuredMailSource({
    db,
    mailboxHandle: 'consumer',
    dispatchId: null,
    message: a,
    senderName: () => null
  })
  if (source.orchestration?.message !== 'mail-notice') {
    throw new Error('saved batch source missing')
  }
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'saved ordinary batch content' }],
    from: {
      ...source,
      orchestration: {
        ...source.orchestration,
        messages: [
          ...source.orchestration.messages,
          { messageId: b.id, runId: b.run_id, from: b.from_handle }
        ]
      }
    }
  }
  expect(
    await sendAgentTurn({
      kind: 'structured-session',
      host: rig.host,
      sessionId: SESSION,
      callerKey: 'trusted-local:orchestration:session:old',
      turn: {
        body,
        operationId: oldId,
        expectedRuntimeFence: 1,
        delivery: 'queue',
        queueAlways: true
      }
    })
  ).toMatchObject({ kind: 'queued' })
  expect(await rig.deleteQueued(oldId)).toMatchObject({ ok: true })
  db.db.exec('ALTER TABLE messages ADD COLUMN handoff TEXT')
  const hint = JSON.stringify({
    version: 1,
    kind: 'structured',
    operationId: oldId,
    manifest: { members: [a.id, b.id] }
  })
  for (const row of [a, b]) {
    db.db
      .prepare('UPDATE messages SET ordering_origin = NULL, handoff = ? WHERE id = ?')
      .run(hint, row.id)
  }
  db.markAsRead([a.id, b.id])
  await rig.restartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  const sends = vi.spyOn(rig.host, 'send')
  bridge.resetForDatabaseChange()
  bridge.deliverForHandle('consumer')
  await eventually(() =>
    expect([a, b].every((row) => db.getMessageById(row.id)?.delivered_at !== null)).toBe(true)
  )
  expect(sends).not.toHaveBeenCalled()
  expect(rig.store.readCommandReceipt({ kind: 'global' }, oldId)).toMatchObject({
    verdict: 'readable',
    receipt: { status: 'accepted' }
  })
})
