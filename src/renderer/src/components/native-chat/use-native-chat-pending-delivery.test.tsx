// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS,
  useNativeChatPendingDelivery
} from './use-native-chat-pending-delivery'
import { clearPendingSendCacheForTests } from './native-chat-pending'
import { useAppStore } from '../../store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

const boundary: NativeChatMessage = {
  id: 'boundary',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'before' }],
  timestamp: null,
  source: 'transcript'
}
const args = { paneKey: 'pane', agent: 'claude' as const }
function userRow(text: string): NativeChatMessage {
  return { ...boundary, id: `user:${text}`, role: 'user', blocks: [{ type: 'text', text }] }
}
function hookRow(
  state: AgentStatusEntry['state'],
  turnStartedAt?: number,
  agentType: AgentStatusEntry['agentType'] = 'claude'
) {
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        pane: {
          paneKey: 'pane',
          agentType,
          state,
          turnStartedAt,
          prompt: '',
          updatedAt: Date.now(),
          stateStartedAt: Date.now()
        }
      }
    })
  )
}
function render() {
  return renderHook(
    ({ messages }) => useNativeChatPendingDelivery({ ...args, session: { messages } }),
    {
      initialProps: { messages: [boundary] }
    }
  )
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  clearPendingSendCacheForTests()
  useAppStore.setState({ agentStatusByPaneKey: {} })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('terminal Chat pending delivery', () => {
  it.each(['claude', 'openclaude'] as const)(
    'uses %s hook rows for OpenClaude idle and working baselines',
    async (source) => {
      for (const state of ['waiting', 'working'] as const) {
        hookRow(state, 10, source)
        const chat = renderHook(() =>
          useNativeChatPendingDelivery({
            ...args,
            agent: 'openclaude',
            session: { messages: [boundary] }
          })
        )
        act(() => chat.result.current.confirmWrite(chat.result.current.record(state)))
        await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
        expect(chat.result.current.pending[0]?.delivery).toBe(
          state === 'working' ? undefined : 'unconfirmed'
        )
        expect(chat.result.current.pending[0]?.writeUnconfirmedAt !== undefined).toBe(
          state !== 'working'
        )
        chat.unmount()
        clearPendingSendCacheForTests()
      }
    }
  )
  it('records a send into a read empty transcript as after every row of that session', () => {
    const { result } = renderHook(() =>
      useNativeChatPendingDelivery({
        ...args,
        session: { messages: [], readPhase: 'ready', sessionId: 'session-1' }
      })
    )
    act(() => result.current.record('first'))
    expect(result.current.pending[0]).toMatchObject({
      afterMessageId: null,
      afterEmptyTranscriptSessionId: 'session-1'
    })
  })
  it.each([
    ['still loading', { readPhase: 'loading' as const, sessionId: 'session-1' }],
    ['no session yet', { readPhase: 'ready' as const, sessionId: null }]
  ])('does not claim an empty transcript while %s', (_label, session) => {
    const { result } = renderHook(() =>
      useNativeChatPendingDelivery({ ...args, session: { messages: [], ...session } })
    )
    act(() => result.current.record('first'))
    expect(result.current.pending[0]?.afterEmptyTranscriptSessionId).toBeUndefined()
  })
  it('keeps a send, and its failure notice, when a different session with old history loads', () => {
    const old: NativeChatMessage[] = [
      { ...userRow('run tests'), id: 'old-user', timestamp: 10 },
      { ...boundary, id: 'old-answer', timestamp: 20 }
    ]
    const initialSession: Parameters<typeof useNativeChatPendingDelivery>[0]['session'] = {
      messages: [],
      readPhase: 'ready',
      sessionId: 'new-session'
    }
    const { result, rerender } = renderHook(
      ({ session }) => useNativeChatPendingDelivery({ ...args, session }),
      { initialProps: { session: initialSession } }
    )
    act(() => {
      result.current.reject(result.current.record('run tests'))
    })
    rerender({ session: { messages: old, readPhase: 'ready', sessionId: 'resumed-session' } })
    expect(result.current.pending.map((entry) => entry.text)).toEqual(['run tests'])
    expect(result.current.notices.size).toBe(1)
  })
  it('holds an acknowledged idle send until 20 s with no agent or transcript evidence', async () => {
    hookRow('waiting', 10)
    const { result } = render()
    act(() => result.current.confirmWrite(result.current.record('swallowed')))
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS - 1)
    expect(result.current.notices.size).toBe(0)
    await tick(1)
    expect([...result.current.notices.values()][0]?.text).toMatch(/Delivery unconfirmed/)
  })
  it.each([1_000, 21_000])(
    'clears uncertainty on a turn start at %s ms, across remount',
    async (elapsed) => {
      hookRow('waiting', 10)
      const first = render()
      act(() => first.result.current.confirmWrite(first.result.current.record('rewritten prompt')))
      await tick(elapsed)
      expect(first.result.current.notices.size).toBe(elapsed > 20_000 ? 1 : 0)
      first.unmount()
      hookRow('working', 5)
      const next = render()
      await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
      expect(next.result.current.notices.size).toBe(0)
      expect(next.result.current.pending[0]?.writeUnconfirmedAt).toBeUndefined()
    }
  )
  it('does not treat a session boundary or restated turn as acceptance', async () => {
    hookRow('waiting', 10)
    const { result } = render()
    act(() => result.current.confirmWrite(result.current.record('swallowed')))
    hookRow('waiting')
    hookRow('working', 10)
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
    expect(result.current.pending[0]?.delivery).toBe('unconfirmed')
  })
  it('accepts only the oldest send per turn, even after that send retires and chat remounts', async () => {
    hookRow('waiting', 10)
    const first = render()
    act(() => {
      first.result.current.confirmWrite(first.result.current.record('first'))
      first.result.current.confirmWrite(first.result.current.record('second'))
    })
    hookRow('working', 20)
    first.rerender({ messages: [boundary, userRow('first'), { ...boundary, id: 'answer' }] })
    first.unmount()
    const next = render()
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
    expect(next.result.current.pending.map((entry) => [entry.text, entry.delivery])).toEqual([
      ['second', 'unconfirmed']
    ])
    hookRow('working', 30)
    expect(next.result.current.notices.size).toBe(0)
  })
  it('recognizes an older host idle-to-working transition without a turn clock', async () => {
    hookRow('waiting')
    const { result } = render()
    act(() => result.current.confirmWrite(result.current.record('accepted')))
    hookRow('working')
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
    expect(result.current.notices.size).toBe(0)
    expect(result.current.pending[0]?.writeUnconfirmedAt).toBeUndefined()
  })
  it('keeps an agent turn observed before the Enter acknowledgment', async () => {
    hookRow('waiting', 10)
    const { result } = render()
    let id = ''
    act(() => {
      id = result.current.record('accepted')
    })
    hookRow('working', 20)
    act(() => result.current.confirmWrite(id))
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
    expect(result.current.notices.size).toBe(0)
    expect(result.current.pending[0]?.writeUnconfirmedAt).toBeUndefined()
  })
  it('does not arm an acceptance hold for a working baseline or an agent without a turn hook', async () => {
    hookRow('working', 10)
    const working = render()
    act(() => working.result.current.confirmWrite(working.result.current.record('queued')))
    const unsupported = renderHook(() =>
      useNativeChatPendingDelivery({
        paneKey: 'other',
        agent: 'opencode',
        session: { messages: [boundary] }
      })
    )
    act(() => unsupported.result.current.confirmWrite(unsupported.result.current.record('no hook')))
    await tick(10 * 60_000)
    for (const current of [working.result.current, unsupported.result.current]) {
      expect(current.notices.size).toBe(0)
      expect(current.pending[0]?.writeUnconfirmedAt).toBeUndefined()
    }
  })
  it('marks a refused write as not sent, keeps its text, and dismisses it', () => {
    const { result } = render()
    act(() => {
      result.current.reject(result.current.record('refused'))
    })
    expect(result.current.pending[0]?.text).toBe('refused')
    expect([...result.current.notices.values()][0]?.text).toBe('Message not sent')
    act(() => [...result.current.notices.values()][0]?.onDismiss?.())
    expect(result.current.pending).toEqual([])
  })
  it('reports a lost acknowledgment as unconfirmed only after the hold passes with no row', async () => {
    const { result } = render()
    act(() => {
      result.current.holdUnconfirmed(result.current.record('lost ack'))
    })
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS - 1)
    expect(result.current.notices.size).toBe(0)
    await tick(1)
    expect([...result.current.notices.values()][0]?.text).toMatch(/Delivery unconfirmed/)
    expect(result.current.pending[0]?.text).toBe('lost ack')
  })
  it('clears a held send whose echo lands, before or after the hold ends', async () => {
    const { result, rerender } = render()
    act(() => {
      result.current.holdUnconfirmed(result.current.record('early'))
      result.current.holdUnconfirmed(result.current.record('late'))
    })
    rerender({ messages: [boundary, userRow('early')] })
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
    expect(result.current.pending.map((entry) => [entry.text, entry.delivery])).toEqual([
      ['early', undefined],
      ['late', 'unconfirmed']
    ])
    rerender({
      messages: [boundary, userRow('early'), userRow('late'), { ...boundary, id: 'answer' }]
    })
    expect(result.current.pending).toEqual([])
  })
  it.each(['rejected', 'unconfirmed'] as const)(
    'retires a resend of a %s message once its row lands',
    async (outcome) => {
      const { result, rerender } = render()
      act(() => {
        const id = result.current.record('try again')
        if (outcome === 'rejected') {
          result.current.reject(id)
        } else {
          result.current.holdUnconfirmed(id)
        }
      })
      await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
      expect(result.current.pending[0]?.delivery).toBe(outcome)
      act(() => result.current.record('try again'))
      expect(result.current.pending.map((entry) => entry.delivery)).toEqual([undefined])
      rerender({ messages: [boundary, userRow('try again'), { ...boundary, id: 'answer' }] })
      expect(result.current.pending).toEqual([])
    }
  )
  it('keeps a failed send through Stop while dropping sends Stop may have cancelled', () => {
    const { result } = render()
    act(() => {
      result.current.reject(result.current.record('refused'))
      result.current.record('in flight')
    })
    act(() => result.current.clear())
    expect(result.current.pending.map((entry) => [entry.text, entry.delivery])).toEqual([
      ['refused', 'rejected']
    ])
  })
  it('keeps the hold deadline across a remount', async () => {
    const first = render()
    act(() => {
      first.result.current.holdUnconfirmed(first.result.current.record('remounted'))
    })
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS / 2)
    first.unmount()
    const next = render()
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS / 2)
    expect(next.result.current.pending[0]?.delivery).toBe('unconfirmed')
  })
  it('keeps pending and notices referentially stable across stream updates', () => {
    const { result, rerender } = render()
    act(() => result.current.record('stable'))
    const { pending, notices } = result.current
    rerender({ messages: [boundary, { ...boundary, id: 'streamed' }] })
    expect(result.current.pending).toBe(pending)
    expect(result.current.notices).toBe(notices)
  })
})
