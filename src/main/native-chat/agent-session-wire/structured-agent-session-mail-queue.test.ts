import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { mailSourceIncarnation } from '../../runtime/orchestration/db/messages/mail-source-order'
import { OrchestrationStructuredMailboxPointerDelivery } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { readMailHandoff } from '../../runtime/orchestration/mail-handoff'
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
  // The source-cut producer is covered with the real cross-DB reservation in journal-mail-holds.
  rig.host.deps.captureSessionMail = () => ({
    cut: {
      incarnation: mailSourceIncarnation(db.db),
      throughSequence: Number(
        db.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM messages').get()?.n
      ),
      direct: ['consumer'],
      runs: [],
      dispatches: []
    }
  })
})
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
  let id: string | undefined
  await eventually(() => {
    const reference = readMailHandoff(db.getMessageById(messageId)?.handoff)
    expect(reference).toMatchObject({ kind: 'structured', phase: 'offered' })
    if (reference?.kind === 'structured') {
      id = reference.clientMessageId
    }
    expect(id && journal().queuedMessages.get(id)).toBeTruthy()
  })
  if (!id) {
    throw new Error('queue identity missing')
  }
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
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
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
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
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
  await complete(await rig.handoffId(freshId))
  expect(await rig.sendNow(oldId)).toMatchObject({
    ok: true,
    value: { submission: { source: { kind: 'agent' }, origin: 'client' } }
  })
  expect(journal().mailHoldFacts().ambiguous).toBe(false)
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
    const inventory = vi.spyOn(db, 'getIssuedSessionMail')
    for (let i = 0; i < 10; i++) {
      expect(readQueuePublication(journal(), gate)).toBe(before)
      bridge.onJournalActivity(SESSION)
    }
    expect(list).not.toHaveBeenCalled()
    expect(inventory).not.toHaveBeenCalled()
    bridge.forgetSession(SESSION)
    bridge.onJournalActivity(SESSION)
    expect(inventory).not.toHaveBeenCalled()
    expect((await rig.submission(working))?.source?.kind).toBe('user')
  }
)
