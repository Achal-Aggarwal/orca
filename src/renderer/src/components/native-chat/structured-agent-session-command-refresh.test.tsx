// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useStructuredAgentSessionCommandMenu } from './structured-agent-session-command-refresh'

const call = vi.hoisted(() => vi.fn(async () => ({ commandsPending: false })))
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession: call }))

it('revalidates an open menu after account retirement and cancels demand on close', async () => {
  const target = { kind: 'local' } as const
  const commands = [{ name: 'plugin:check', kind: 'command' as const }]
  const { result, rerender, unmount } = renderHook(
    (known: boolean) =>
      useStructuredAgentSessionCommandMenu(target, 'one', true, known ? commands : null),
    { initialProps: true }
  )
  expect(call).not.toHaveBeenCalled()
  act(() => result.current.setOpen(true))
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  rerender(false)
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  rerender(true)
  act(() => result.current.setOpen(false))
  rerender(false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(call).toHaveBeenCalledTimes(2)
  unmount()
})
