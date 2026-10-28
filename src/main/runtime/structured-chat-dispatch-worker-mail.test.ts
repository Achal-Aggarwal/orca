import './rpc/unused-default-rpc-methods.test-fixture'
// Ordinary creation ends source delivery even when the provider later dies.

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  clearChat,
  codex,
  connectionFor,
  coordinatorRunAndTask,
  db,
  dispatcher,
  request,
  host,
  observationClock,
  openChat,
  restartRuntime,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
const POINTER = /Orchestration message/

async function idleEdges(sessionId: string): Promise<void> {
  runtime.onStructuredSessionStatusForMail({ sessionId, status: null })
  runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
  await observationClock.observe(400)
  await host.flushStreamedEvents(sessionId)
}

/** Coordinator mail to the peer chat's Dispatch, its pointer lost with the provider. */
async function heldDispatchMail(): Promise<string> {
  await openChat(COORDINATOR)
  const chat = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const { dispatch } = await call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER },
    { sessionId: COORDINATOR }
  )
  const mailbox = `dispatch:${idOf(dispatch)}`
  await call('orchestration.send', { to: mailbox, subject: 'more' }, { sessionId: COORDINATOR })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  expect(turnText(chat.turns[0]!)).toMatch(POINTER)
  chat.handlers.onExit?.(new Error('provider died before the echo'))
  await idleEdges(PEER_CHAT)
  expect(chat.turns).toHaveLength(1)
  expect(db.getUndeliveredUnreadMessages(mailbox, undefined, {})).toHaveLength(0)
  return mailbox
}

/** The chat's next turn, the person's; resolves to the session's provider once its edges ran. */
async function nextTurn(sessionId: string): Promise<{ turns: { text: string }[] }> {
  const before = codex.connections.length
  expect(await sendUserMessage(sessionId, 'again')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
  const revived = connectionFor(sessionId)
  await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
  await settleTurn(sessionId, 0)
  await idleEdges(sessionId)
  return revived
}

describe("a chat worker's accepted Dispatch mail is never offered again", () => {
  // Also covered by the restored-mail repoint a restart schedules; this pins the end result.
  it('after a restart', async () => {
    observationClock.start()
    await heldDispatchMail()
    restartRuntime()

    const revived = await nextTurn(PEER_CHAT)

    expect(revived.turns).toHaveLength(1)
  })

  it('in the same chat after /clear', async () => {
    observationClock.start()
    await heldDispatchMail()
    const cleared = await clearChat(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)

    const revived = await nextTurn(cleared)

    expect(revived.turns).toHaveLength(1)
  })
})

it('a real background Run peek finishes before ordinary push, and consuming replay/ack remains independent', async () => {
  const chat = await openChat(COORDINATOR)
  const { runId } = await coordinatorRunAndTask()
  const mailbox = `run:${runId}`
  const wait = vi.spyOn(runtime, 'waitForMessage')
  const peek = call(
    'orchestration.check',
    { run: runId, peek: true, wait: true, timeoutMs: 10000 },
    { sessionId: COORDINATOR }
  )
  await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(mailbox, expect.anything()))
  const source = db.insertMessage({
    from: 'worker',
    to: mailbox,
    runId,
    subject: 'out-of-turn peek then ordinary report'
  })
  runtime.notifyMessageArrived(mailbox, source.type)
  expect(await peek).toMatchObject({ count: 1, messages: [{ id: source.id }] })
  expect(runtime.messageWaitersByHandle.size).toBe(0)
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  expect(db.getMessageById(source.id)).toMatchObject({ read: 0, delivered_at: expect.any(String) })
  await settleTurn(COORDINATOR, 0, 'completed')
  const consume = await call('orchestration.check', { run: runId }, { sessionId: COORDINATOR })
  expect(consume).toMatchObject({ count: 1, messages: [{ id: source.id }] })
  expect(
    await call('orchestration.check', { run: runId }, { sessionId: COORDINATOR })
  ).toMatchObject({ deliveryId: consume.deliveryId, replayed: true })
  expect(
    await call(
      'orchestration.check',
      { run: runId, ack: consume.deliveryId },
      { sessionId: COORDINATOR }
    )
  ).toMatchObject({ count: 0 })
  expect(db.getMessageById(source.id)?.read).toBe(1)
  expect(chat.turns).toHaveLength(1)
  wait.mockClear()
  const consuming = call(
    'orchestration.check',
    { run: runId, wait: true, timeoutMs: 10000 },
    { sessionId: COORDINATOR }
  )
  await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(mailbox, expect.anything()))
  const fifo = ['first consumer opportunity', 'second consumer opportunity'].map((subject) =>
    db.insertMessage({ from: 'worker', to: mailbox, runId, subject })
  )
  for (const message of fifo) {
    runtime.notifyMessageArrived(mailbox, message.type)
  }
  const delivery = await consuming
  expect(delivery).toMatchObject({
    count: 2,
    messages: fifo.map((message) => ({ id: message.id }))
  })
  expect(runtime.messageWaitersByHandle.size).toBe(0)
  await observationClock.observe(100)
  expect(chat.turns).toHaveLength(1)
  expect(fifo.every((message) => db.getMessageById(message.id)?.delivered_at === null)).toBe(true)
  expect(
    await call('orchestration.check', { run: runId }, { sessionId: COORDINATOR })
  ).toMatchObject({ deliveryId: delivery.deliveryId, replayed: true })
  expect(
    await call(
      'orchestration.check',
      { run: runId, ack: delivery.deliveryId },
      { sessionId: COORDINATOR }
    )
  ).toMatchObject({ count: 0 })
  expect(fifo.every((message) => db.getMessageById(message.id)?.read === 1)).toBe(true)
  const final = db.insertMessage({
    from: 'worker',
    to: mailbox,
    runId,
    subject: 'ordinary after completed consumption'
  })
  runtime.notifyMessageArrived(mailbox, final.type)
  await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
  await settleTurn(COORDINATOR, 1, 'completed')
  const lastDelivery = await call('orchestration.check', { run: runId }, { sessionId: COORDINATOR })
  expect(lastDelivery).toMatchObject({ messages: [{ id: final.id }] })
  expect(
    await call(
      'orchestration.check',
      { run: runId, ack: lastDelivery.deliveryId },
      { sessionId: COORDINATOR }
    )
  ).toMatchObject({ count: 0 })
  expect(db.getUnreadRunMailbox(runId)).toEqual([])
})

it('actual typed timeout and aborted checks release hidden mail without another arrival or idle edge', async () => {
  const chat = await openChat(PEER_CHAT)
  const mailbox = WORKER
  const wait = vi.spyOn(runtime, 'waitForMessage')
  const controller = new AbortController()
  const check = dispatcher.dispatch(
    request(
      'orchestration.check',
      { terminal: WORKER, types: 'status', wait: true, peek: true, timeoutMs: 10000 },
      { sessionId: PEER_CHAT }
    ),
    { signal: controller.signal }
  )
  await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(mailbox, expect.anything()))
  const scoped = runtime.waitForMessage(mailbox, { typeFilter: ['status'], timeoutMs: 25 })
  const source = db.insertMessage({
    from: 'worker',
    to: mailbox,
    subject: 'held for actual check abort'
  })
  // No notify is lost in this test: an unnotified real request owns the source until abort/timeout.
  runtime.deliverPendingMessagesForHandle(mailbox)
  controller.abort()
  expect(await check).toMatchObject({ ok: true })
  expect(await scoped).toBe('timed_out')
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  expect(runtime.messageWaitersByHandle.size).toBe(0)
  expect(db.getMessageById(source.id)).toMatchObject({ read: 0, delivered_at: expect.any(String) })
  await settleTurn(PEER_CHAT, 0, 'completed')
})
