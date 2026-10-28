import { expect, it } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { phoneRelayFlow } from './structured-phone-relay.test-fixture'
import { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'

it('keeps the host alert while a desktop observes and retires only a genuine later live root', async () => {
  const f = await phoneRelayFlow()
  const relay = await f.stream({ includePrompts: true }, true)
  const notifications = () => f.sent.filter((event) => event.type === 'notification')
  const dismissals = () => f.sent.filter((event) => event.type === 'dismiss')
  try {
    const first = await f.send('From the forwarding desktop')
    await f.turn('first', first, 'running')
    await f.turn('first', first, 'completed')
    expect(notifications()).toHaveLength(1)
    expect(f.forwarded.filter((event) => event.type === 'notification')).toHaveLength(1)
    relay.close()
    const second = await f.send('Desktop stream disconnected before the news')
    await f.turn('second', second, 'running')
    await f.turn('second', second, 'completed')
    expect(notifications()).toHaveLength(2)
    const alert = notifications()[1]!
    const priorDismissals = dismissals().length
    expect(priorDismissals).toBe(1)
    const third = await f.send('Acceptance is not a start')
    expect(dismissals()).toHaveLength(priorDismissals)
    await f.turn('third', third, 'running')
    expect(dismissals().slice(priorDismissals)).toEqual([
      expect.objectContaining({
        dismissedDelivery: {
          notificationId: alert.notificationId,
          notificationEpoch: alert.notificationEpoch,
          notificationSeq: alert.notificationSeq
        }
      })
    ])
    await f.turn('third', third, 'completed')
    await f.stream({ includePrompts: true }, true)
    await f.turn('unknown-origin', 'not-a-submission', 'running')
    await f.turn('unknown-origin', 'not-a-submission', 'completed')
    expect(notifications()).toHaveLength(4)
    const count = dismissals().length
    const restarted = new RuntimeMobileNotificationController()
    const restartedEvents: unknown[] = []
    const stopRestarted = restarted.onDispatched((event) => restartedEvents.push(event))
    try {
      restarted.retireLiveStructuredTurn(SESSION, f.journal.cursor(), 0)
      expect(restartedEvents).toEqual([])
      expect(dismissals()).toHaveLength(count)
    } finally {
      stopRestarted()
      await restarted.closeDismissals()
    }
  } finally {
    await f.close()
  }
})

it('admits the2165558 native request and {} subscription while the host sends its prompt alert', async () => {
  const f = await phoneRelayFlow()
  try {
    const old = await f.stream({})
    const command = await f.send('Historical plain-text follow-up')
    await f.turn('historical-client', command, 'running')
    await f.prompt(1, 'historical-client')
    expect(old.replies).toEqual([])
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(1)
    await f.turn('historical-client', command, 'completed')
    expect(old.replies.some((reply) => reply.ok)).toBe(true)
  } finally {
    await f.close()
  }
})
