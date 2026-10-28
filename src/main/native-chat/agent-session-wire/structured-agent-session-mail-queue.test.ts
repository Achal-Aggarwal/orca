import { observeMailSqlWork } from '../../runtime/orchestration/mail-sql-work.test-support'
import { orchestrationInboxMethod } from '../../runtime/rpc/methods/orchestration/messaging/inbox-method'
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
import {
  queuedMessagesPublishedBytes,
  QUEUED_MESSAGES_PUBLISHED_MAX_BYTES,
  QUEUED_MESSAGES_PERSON_RESERVE_BYTES
} from './structured-agent-session-queued-published-bytes'
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
    expect(db.getMessageById(messageId)?.delivered_at, message.subject).not.toBeNull()
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

it('accepted composer queued Send during fresh C releases Stop for the complete C/P/A/U ordinary iteration', async () => {
  await rig.workingSend()
  const personal = rig.send('P before Stop', 'queue-if-active')
  expect(await personal.result).toMatchObject({ ok: true, value: { queued: {} } })
  const old = await report('A before Stop')
  const oldId = await card(old.id)
  expect(await rig.stop()).toMatchObject({ ok: true })
  const fresh = await report('C after Stop')
  const freshId = await card(fresh.id)
  const freshTurn = await rig.handoffId(freshId)
  expect(await rig.handoff(personal.id)).toBeUndefined()
  expect(await rig.handoff(oldId)).toBeUndefined()
  const composer = rig.send('U actual composer command', 'queue-if-active')
  expect(await composer.result).toMatchObject({ ok: true, value: { queued: {} } })
  expect(journal().mailBoundary()?.status).toBe('released')
  expect(await rig.handoff(personal.id)).toBeUndefined()
  expect(await rig.handoff(oldId)).toBeUndefined()
  await complete(freshTurn)
  for (const id of [personal.id, oldId, composer.id]) {
    const turn = await rig.handoffId(id)
    await eventually(() =>
      expect(
        rig.dispatch.mock.calls.find(([input]) => input.clientMessageId === turn)?.[0].body.blocks
      ).toEqual(journal().queuedMessages.get(id)?.body.blocks)
    )
    const following = [personal.id, oldId, composer.id].slice(
      [personal.id, oldId, composer.id].indexOf(id) + 1
    )
    for (const waiting of following) {
      expect(await rig.handoff(waiting)).toBeUndefined()
    }
    await complete(turn)
  }
  expect(
    journal()
      .queuedMessages.list()
      .filter((row) => row.state === 'waiting')
  ).toEqual([])
})

it('delivers one bounded long report and recovers its exact independent full text without changing read state', async () => {
  const working = await rig.workingSend()
  const subject = 's'.repeat(400),
    body = 'b'.repeat(1200),
    payload = `\`\`\`\`\`\`\n${'payload'.repeat(1000)}`
  const row = db.insertMessage({ from: 'worker', to: 'consumer', subject, body, payload })
  bridge.deliverForHandle('consumer')
  const id = await card(row.id)
  const text = journal()
    .queuedMessages.get(id)!
    .body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
  expect(text).toContain(subject)
  expect(text).toContain(body)
  expect(text).toContain(`\`\`\`\`\`\`\`\n${payload.slice(0, 2400)}\n\`\`\`\`\`\`\``)
  expect(text).not.toContain(payload)
  expect(text).toContain(`orchestration inbox --id ${row.id} --full`)
  expect(text).toContain(`orchestration inbox --terminal consumer --full --limit 100`)
  for (let n = 0; n < 21; n++) {
    db.insertMessage({ from: 'other', to: 'other', subject: 'new history' })
  }
  // SAFETY: this real handler reads only getOrchestrationDb; no other runtime operation is reachable.
  const context = { runtime: { getOrchestrationDb: () => db } } as never
  const exact = await orchestrationInboxMethod.handler(
    orchestrationInboxMethod.params.parse({ id: row.id, terminal: 'consumer' }),
    context
  )
  expect(exact).toMatchObject({
    count: 1,
    messages: [{ id: row.id, subject, body, payload, read: 0 }]
  })
  expect(
    await orchestrationInboxMethod.handler(
      orchestrationInboxMethod.params.parse({ id: row.id, terminal: 'other' }),
      context
    )
  ).toMatchObject({ count: 0 })
  expect(db.getMessageById(row.id)).toMatchObject({ read: 0, delivered_at: expect.any(String) })
  await complete(working)
  await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
  const attempt = await rig.handoffId(id)
  await eventually(() =>
    expect(
      rig.dispatch.mock.calls.find(([input]) => input.clientMessageId === attempt)?.[0].body.blocks
    ).toEqual(journal().queuedMessages.get(id)?.body.blocks)
  )
  await complete(attempt)
  expect(db.getUnreadMessages('consumer').map((row) => row.id)).toEqual([row.id])
})

it('observed new source identities with missing or imported order become held ordinary cards, survive reopen, and release only on real Resume', async () => {
  await rig.workingSend()
  await rig.stop()
  const rows = [await report('missing order', false), await report('imported order', false)]
  db.db.prepare('UPDATE messages SET ordering_origin = NULL WHERE id = ?').run(rows[0].id)
  db.db.prepare('UPDATE messages SET ordering_origin = ? WHERE id = ?').run('imported', rows[1].id)
  bridge.deliverForHandle('consumer')
  const ids = []
  for (const row of rows) {
    ids.push(await card(row.id))
  }
  for (const id of ids) {
    expect(await rig.handoff(id)).toBeUndefined()
  }
  await rig.restartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  bridge.resetForDatabaseChange()
  await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(journal().mailHoldFacts().held).toBe(true)
  expect(await rig.resume()).toMatchObject({ ok: true })
  for (const id of ids) {
    await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
    await complete(await rig.handoffId(id))
  }
  expect(
    ids.every((id) => rig.store.readCommandReceipt({ kind: 'global' }, id).verdict === 'readable')
  ).toBe(true)
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

it('ordinary Edit and Delete capacity wakes skip a refused older report for a fresh admissible full turn without releasing Stop', async () => {
  await rig.workingSend()
  const personal = []
  for (let n = 0; n < 4; n++) {
    const send = rig.send('p'.repeat(200_000), 'queue-if-active')
    expect(await send.result).toMatchObject({ ok: true, value: { queued: {} } })
    personal.push(send.id)
  }
  rig.host.deps.onSessionMailActivity = (id) => bridge.onJournalActivity(id)
  const sends = vi.spyOn(rig.host, 'send')
  const source = db.insertMessage({
    from: 'worker',
    to: 'consumer',
    subject: 'older large report',
    body: '🚀'.repeat(5000)
  })
  bridge.deliverForHandle('consumer')
  const id = ordinaryMailCreationId(source)
  await eventually(() => expect(sends).toHaveBeenCalled())
  expect(db.getMessageById(source.id)?.delivered_at).toBeNull()
  expect(rig.store.readCommandReceipt({ kind: 'global' }, id).verdict).toBe('absent')
  expect(await rig.stop()).toMatchObject({ ok: true })
  const fresh = await report('fresh small after Stop')
  await clock.observe(100)
  expect(db.getMessageById(fresh.id)?.delivered_at).toBeNull()
  const row = journal().queuedMessages.get(personal[0]!)!
  const shrink =
    queuedMessagesPublishedBytes(journal()) -
    (QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - QUEUED_MESSAGES_PERSON_RESERVE_BYTES - 3000)
  const fields = {
    messageId: row.messageId,
    expectedBodyFingerprint: row.fingerprint,
    text: 'p'.repeat(200000 - shrink)
  }
  expect(
    await rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
      ...fields,
      envelope: rig.envelope(fields, 'agentSession.queuedMessageUpdate', hostTestOperationId())
    })
  ).toMatchObject({ ok: true, value: { status: 'updated' } })
  const freshId = await card(fresh.id)
  await eventually(async () =>
    expect(await rig.handoff(freshId)).toMatchObject({ source: { kind: 'agent' } })
  )
  expect(db.getMessageById(source.id)?.delivered_at).toBeNull()
  expect(await rig.handoff(personal[1]!)).toBeUndefined()
  expect(journal().mailBoundary()?.status).toBe('held')
  await complete(await rig.handoffId(freshId))
  expect(await rig.deleteQueued(personal[0]!)).toMatchObject({ ok: true })
  await card(source.id)
  const attempts = sends.mock.calls.filter(([, input]) => input.envelope.clientOperationId === id)
  expect(attempts.length).toBeGreaterThan(1)
  expect(journal().queuedMessages.get(id)?.state).toBe('waiting')
  expect(await rig.handoff(id)).toBeUndefined()
  expect(await rig.resume()).toMatchObject({ ok: true })
  for (const waiting of [...personal.slice(1), id]) {
    await eventually(async () => expect(await rig.handoff(waiting)).toBeDefined())
    await complete(await rig.handoffId(waiting))
  }
  expect(rig.cancelTurn).toHaveBeenCalledTimes(1)
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
  db.resetTasks()
  // The historical helper hand-back cleared this hint independently of ordering provenance.
  db.db.prepare('UPDATE messages SET handoff = NULL WHERE id IN (?, ?)').run(a.id, b.id)
  db.db.prepare('UPDATE messages SET ordering_origin = ? WHERE id = ?').run('local', b.id)
  db.markAsRead([a.id, b.id])
  await rig.restartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  bridge.resetForDatabaseChange()
  const unobserved = db.insertMessage({
    from: 'worker',
    to: 'consumer',
    subject: 'unobserved old source with no creation coverage'
  })
  db.db.prepare('UPDATE messages SET read = 0, handoff = ? WHERE id = ?').run(
    JSON.stringify({
      version: 1,
      kind: 'structured',
      operationId: hostTestOperationId(),
      manifest: { members: [b.id] }
    }),
    b.id
  )
  const sends = vi.spyOn(rig.host, 'send')
  const database = rig.host.deps.journalDatabase.db
  const originals = database
    .prepare(`SELECT * FROM journal_rows WHERE session_id = ?
    AND json_extract(row_json, '$.messageId') = ? AND json_extract(row_json, '$.change.op') = 'queued'`)
    .all(SESSION, oldId)
  expect(originals).toHaveLength(1)
  const saved = originals[0]!
  await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  await journal().replaceEpochItems('handle_forked', 1, [])
  expect(
    database
      .prepare('SELECT 1 FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?')
      .get(SESSION, saved.epoch, saved.seq)
  ).toBeUndefined()
  bridge.deliverForHandle('consumer')
  await clock.observe(100)
  expect(sends).not.toHaveBeenCalled()
  expect([a, b, unobserved].every((row) => db.getMessageById(row.id)?.delivered_at === null)).toBe(
    true
  )
  expect(await rig.resume()).toMatchObject({ ok: true })
  await clock.observe(100)
  expect(sends).not.toHaveBeenCalled()
  // Recovery restores the actual original evidence; a human release never invents membership.
  const columns = Object.keys(saved)
  database
    .prepare(
      `INSERT INTO journal_rows (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    .run(...columns.map((column) => saved[column]))
  bridge.resetForDatabaseChange()
  const membership = observeMailSqlWork(
    database,
    (sql) => sql.includes('SELECT row_json FROM journal_rows'),
    'row_json'
  )
  const receiptReads = vi.spyOn(rig.store, 'readCommandReceipt')
  bridge.deliverForHandle('consumer')
  await eventually(() =>
    expect([a, b].every((row) => db.getMessageById(row.id)?.delivered_at !== null)).toBe(true)
  )
  expect(membership.count()).toBe(1)
  expect(membership.calls.reduce((sum, call) => sum + call.bytes, 0)).toBeGreaterThan(0)
  expect(membership.calls.reduce((sum, call) => sum + call.bytes, 0)).toBeLessThan(10000)
  expect(receiptReads.mock.calls.filter(([, operation]) => operation === oldId)).toHaveLength(1)
  membership.verify()
  console.info('legacy original-domain membership rows/bytes/arguments', membership.calls)
  membership.restore()
  expect(db.getMessageById(unobserved.id)).toMatchObject({ read: 0, delivered_at: null })
  expect(journal().queuedMessages.get(ordinaryMailCreationId(unobserved))).toBeNull()
  expect(sends).not.toHaveBeenCalled()
  expect(rig.store.readCommandReceipt({ kind: 'global' }, oldId)).toMatchObject({
    verdict: 'readable',
    receipt: { status: 'accepted' }
  })
})
