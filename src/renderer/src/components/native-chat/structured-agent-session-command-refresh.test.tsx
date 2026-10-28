// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useStructuredAgentSessionCommandMenu } from './structured-agent-session-command-refresh'

const call = vi.hoisted(() => vi.fn(async () => ({ commandsPending: false })))
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession: call }))

afterEach(() => vi.useRealTimers())

it('revalidates an open menu after account retirement and cancels demand on close', async () => {
  vi.useFakeTimers()
  const target = { kind: 'local' } as const
  const commands = [{ name: 'plugin:check', kind: 'command' as const }]
  const { result, rerender, unmount } = renderHook(
    (known: boolean) =>
      useStructuredAgentSessionCommandMenu(target, 'one', true, known ? commands : null),
    { initialProps: true }
  )
  expect(call).not.toHaveBeenCalled()
  await act(async () => result.current.setOpen(true))
  expect(call).toHaveBeenCalledTimes(1)
  rerender(false)
  await act(async () => vi.advanceTimersByTimeAsync(0))
  expect(call).toHaveBeenCalledTimes(2)
  rerender(true)
  act(() => result.current.setOpen(false))
  rerender(false)
  await act(async () => vi.advanceTimersByTimeAsync(330_000))
  expect(call).toHaveBeenCalledTimes(2)
  unmount()
})
