import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'

type Hook = ReturnType<typeof useMobileStructuredSessionCommands>

describe('useMobileStructuredSessionCommands', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Probe(props: { client: RpcClient; sessionId: string; commandsOnRequest?: boolean }) {
    hook = useMobileStructuredSessionCommands({ ...props, hostId: 'host-1', enabled: true })
    return null
  }

  it('reads the session’s list, again when the menu opens, and never shows another session’s', async () => {
    const lists: Record<string, { name: string; kind: 'skill' | 'command' }[]> = {
      a: [{ name: 'review-pr', kind: 'skill' }],
      b: [{ name: 'compact', kind: 'command' }]
    }
    const answers: { sessionId: string; answer: () => void }[] = []
    let holdNext = false
    const sendRequest = vi.fn(async (_method: string, params: unknown) => {
      const sessionId =
        typeof params === 'object' && params !== null && 'sessionId' in params
          ? String(params.sessionId)
          : ''
      if (holdNext) {
        holdNext = false
        await new Promise<void>((resolve) => answers.push({ sessionId, answer: resolve }))
      }
      return {
        id: 'rpc-1',
        ok: true as const,
        result: { commands: lists[sessionId] },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    await act(async () => {
      renderer = create(createElement(Probe, { client, sessionId: 'a' }))
    })
    expect(sendRequest).toHaveBeenCalledWith('agentSession.commands', { sessionId: 'a' })
    expect(hook!.commands).toEqual(lists.a)

    lists.a = [...lists.a!, { name: 'research', kind: 'skill' }]
    await act(async () => hook!.refresh())
    expect(hook!.commands?.map((entry) => entry.name)).toEqual(['review-pr', 'research'])

    holdNext = true
    await act(async () => renderer!.update(createElement(Probe, { client, sessionId: 'b' })))
    expect(hook!.commands).toBeUndefined()
    await act(async () => answers.shift()!.answer())
    expect(hook!.commands).toEqual(lists.b)
  })

  it('reads again after the current read when the menu opens during it', async () => {
    let catalog = [{ name: 'review-pr', kind: 'skill' as const }]
    const answers: (() => void)[] = []
    const sendRequest = vi.fn(async () => {
      const answered = [...catalog]
      await new Promise<void>((resolve) => answers.push(resolve))
      return {
        id: 'rpc-1',
        ok: true as const,
        result: { commands: answered },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    await act(async () => {
      renderer = create(createElement(Probe, { client, sessionId: 'a' }))
    })
    catalog = [...catalog, { name: 'research', kind: 'skill' as const }]
    await act(async () => hook!.refresh())
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await act(async () => answers.shift()!())
    expect(sendRequest).toHaveBeenCalledTimes(2)
    await act(async () => answers.shift()!())
    expect(hook!.commands?.map((entry) => entry.name)).toEqual(['review-pr', 'research'])
  })
  it.each(['pending', 'lost-hint', 'lost-reply'])(
    'recovers a %s only while the same menu stays open',
    async (mode) => {
      vi.useFakeTimers()
      let first = true
      const sendRequest = vi.fn(async () => {
        if (first) {
          first = false
          if (mode === 'lost-reply') {
            await new Promise((resolve) => setTimeout(resolve, 30_000))
            throw new Error('transport timeout')
          }
          await new Promise((resolve) => setTimeout(resolve, 10_000))
          return {
            id: 'pending',
            ok: true as const,
            result: { commandsPending: true },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        return {
          id: 'ready',
          ok: true as const,
          result: { commands: [{ name: 'fast', kind: 'command' }], commandsPending: false },
          _meta: { runtimeId: 'runtime-1' }
        }
      })
      const client: RpcClient = {
        sendRequest,
        subscribe: () => () => {},
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => null,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      }
      try {
        await act(async () => {
          renderer = create(
            createElement(Probe, { client, sessionId: 'a', commandsOnRequest: true })
          )
        })
        expect(sendRequest).not.toHaveBeenCalled()
        await act(async () => hook!.setMenuOpen(true))
        if (mode !== 'lost-reply') {
          await act(async () => vi.advanceTimersByTimeAsync(10_000))
          expect(sendRequest).toHaveBeenCalledTimes(1)
          // Probe completion at 12s wakes this demanded target, without a second probe.
          await act(async () => {
            vi.advanceTimersByTime(2_000)
            if (mode === 'pending') {
              hook!.invalidate()
            }
            await vi.advanceTimersByTimeAsync(mode === 'pending' ? 0 : 8_000)
          })
        } else {
          await act(async () => vi.advanceTimersByTimeAsync(40_000))
        }
        expect(hook!.commands?.map((row) => row.name)).toEqual(['fast'])
        expect(sendRequest).toHaveBeenCalledTimes(2)
        await act(async () => hook!.setMenuOpen(false))
        await act(async () => {
          hook!.invalidate()
          await vi.advanceTimersByTimeAsync(330_000)
        })
        expect(sendRequest).toHaveBeenCalledTimes(2)
      } finally {
        act(() => renderer?.unmount())
        renderer = null
        vi.useRealTimers()
      }
    }
  )
})
