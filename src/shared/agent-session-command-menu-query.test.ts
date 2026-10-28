import { afterEach, expect, it, vi } from 'vitest'
import { startAgentSessionCommandMenuQuery } from './agent-session-command-menu-query'

afterEach(() => vi.useRealTimers())

it.each(['completion', 'lost-hint', 'lost-reply'])(
  'recovers slow commands after a %s without closed-menu demand',
  async (mode) => {
    vi.useFakeTimers()
    const commands = [{ name: 'fast', kind: 'command' as const }]
    let ready = false
    const read = vi.fn(async () => {
      if (mode === 'lost-reply' && read.mock.calls.length === 1) {
        throw new Error('lost reply')
      }
      return ready ? { commands, commandsPending: false } : { commandsPending: true }
    })
    const accept = vi.fn()
    const query = startAgentSessionCommandMenuQuery(read, accept)
    try {
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2_000)
      ready = true
      if (mode === 'completion') {
        query.invalidate()
      }
      await vi.advanceTimersByTimeAsync(mode === 'completion' ? 0 : 8_000)
      expect(accept).toHaveBeenLastCalledWith({ commands, commandsPending: false })
      expect(read).toHaveBeenCalledTimes(2)
      query.dispose()
      query.invalidate()
      await vi.advanceTimersByTimeAsync(330_000)
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      query.dispose()
    }
  }
)

it('coalesces invalidation, discards late answers and bounds failed recovery', async () => {
  vi.useFakeTimers()
  const pending = Promise.withResolvers<{ commandsPending: boolean }>()
  const read = vi.fn(() => pending.promise)
  const accept = vi.fn()
  const query = startAgentSessionCommandMenuQuery(read, accept)
  query.invalidate()
  query.invalidate()
  query.dispose()
  pending.resolve({ commandsPending: false })
  await vi.advanceTimersByTimeAsync(330_000)
  expect(read).toHaveBeenCalledTimes(1)
  expect(accept).not.toHaveBeenCalled()
  const fail = vi.fn(async () => {
    throw new Error('transport lost')
  })
  const failed = startAgentSessionCommandMenuQuery(fail, accept)
  try {
    await vi.advanceTimersByTimeAsync(330_000)
    expect(fail).toHaveBeenCalledTimes(3)
  } finally {
    failed.dispose()
  }
})
