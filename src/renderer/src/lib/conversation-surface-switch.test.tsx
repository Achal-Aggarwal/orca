// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSessionReadSnapshot } from '@/components/native-chat/structured-agent-session-read-owner-contract'
import {
  runConversationSwitch,
  useConversationSwitchReadiness,
  conversationSwitchFailureText
} from './conversation-surface-switch'
import { pendingNativeChatCliSwitches } from './pending-conversation-surface-switches'

const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  call: vi.fn(),
  legacy: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  error: vi.fn(),
  info: vi.fn(),
  reader: vi.fn(),
  listeners: new Set<() => void>(),
  subscribe: (listener: () => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error, info: mocks.info } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: mocks.support,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForHost: () => ({ kind: 'local' }),
  executionHostIdForStructuredTarget: () => 'local'
}))
vi.mock('./in-place-switch-support', () => ({
  useInPlaceSwitchRevision: () => 0,
  inPlaceSwitchCapabilityNow: () => true
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    subscribe: mocks.subscribe,
    getSnapshot: () => new Map()
  })
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: mocks.reader
}))
vi.mock('@/components/tab-bar/cli-chat-resume-run', () => ({
  runLegacyCliChatResume: mocks.legacy
}))
vi.mock('@/components/tab-bar/native-chat-cli-switch-run', () => ({
  runLegacyNativeChatCliSwitch: mocks.legacy
}))
vi.mock('@/components/tab-bar/cli-chat-resume-feedback', () => ({
  switchIntoOwnerLegacy: mocks.legacy
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.refresh
}))
vi.mock('@/components/right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.legacy
}))

const subject = {
  direction: 'terminal' as const,
  executionHostId: 'local',
  workspaceId: 'workspace',
  sessionId: 'codex_chat',
  agent: 'codex' as const,
  chatTabId: 'source'
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.reader.mockReturnValue(undefined)
  mocks.support.mockResolvedValue(true)
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: subject.sessionId })
  useAppStore.setState(useAppStore.getInitialState(), true)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  pendingNativeChatCliSwitches.clear()
})

it('reserves pending before negotiation, sends one execution request and leaves all launching to the host', async () => {
  const negotiation = Promise.withResolvers<boolean>()
  mocks.support.mockReturnValue(negotiation.promise)
  const first = runConversationSwitch(subject)
  expect(pendingNativeChatCliSwitches.size).toBe(1)
  expect(await runConversationSwitch(subject)).toBe(false)
  negotiation.resolve(true)
  expect(await first).toBe(true)
  expect(mocks.support).toHaveBeenCalledOnce()
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'local' },
    'agentSession.switchToTerminal',
    expect.objectContaining({
      sessionId: subject.sessionId,
      execution: expect.objectContaining({ sourceTabId: 'source' })
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal), beforeSend: expect.any(Function) })
  )
  expect(mocks.legacy).not.toHaveBeenCalled()
  expect(pendingNativeChatCliSwitches.size).toBe(0)
})

it('keeps an old peer on the explicit v1 adapter without sending execution fields', async () => {
  mocks.support.mockResolvedValue(false)
  await runConversationSwitch(subject)
  expect(mocks.legacy).toHaveBeenCalledOnce()
  expect(mocks.call).not.toHaveBeenCalled()
})

it('starts the full observer at actual first send, without refilling on later observation', async () => {
  vi.useFakeTimers()
  const answer = Promise.withResolvers<unknown>()
  let send: (() => void) | undefined
  mocks.call.mockImplementation((_target, _method, _params, options) => {
    send = options.beforeSend
    return answer.promise
  })
  const running = runConversationSwitch(subject)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700_000)
  })
  expect(send).toBeDefined()
  send!()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40_000)
  })
  expect(pendingNativeChatCliSwitches.size).toBe(1)
  send!()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(695_001)
  })
  expect(await running).toBe(false)
  expect(pendingNativeChatCliSwitches.size).toBe(0)
  answer.resolve({ status: 'completed', sessionId: subject.sessionId })
})

it('clears invocation pending and rereads real state after a lost answer, without hiding a late destination', async () => {
  vi.useFakeTimers()
  const answer = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValue(answer.promise)
  const running = runConversationSwitch(subject)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(735_001)
  })
  expect(await running).toBe(false)
  expect(pendingNativeChatCliSwitches.size).toBe(0)
  expect(mocks.refresh).toHaveBeenCalledWith('workspace', { reacceptCurrentVersion: true })
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('could not confirm the Codex switch')
  )
  answer.resolve({ status: 'completed', sessionId: subject.sessionId })
  await Promise.resolve()
  expect(mocks.error).toHaveBeenCalledOnce()
  expect(mocks.legacy).not.toHaveBeenCalled()
})

it.each(['chat', 'terminal'] as const)(
  'uses held live turn facts for %s, without opening a History reader',
  (direction) => {
    let held: StructuredAgentSessionReadSnapshot = {
      current: true,
      loadingOlder: false,
      olderHistoryGeneration: 0,
      state: { ...EMPTY_STRUCTURED_AGENT_SESSION, working: true }
    }
    mocks.reader.mockReturnValue({ subscribe: mocks.subscribe, getSnapshot: () => held })
    const { result } = renderHook(() => useConversationSwitchReadiness({ ...subject, direction }))
    // Owed/unanswered work is decided by the host at click, not by this broad working flag.
    expect(result.current.ready).toBe(true)
    act(() => {
      held = {
        ...held,
        state: {
          ...held.state,
          latestTurn: {
            itemId: 'codex:turn:turn_123',
            observedAt: 1,
            turn: { turnId: 'turn_123', state: 'running' }
          }
        }
      }
      mocks.listeners.forEach((listener) => listener())
    })
    expect(result.current.ready).toBe(false)
    expect(result.current.explanation).toContain('Codex is replying')
    act(() => {
      held = { ...held, current: false }
      mocks.listeners.forEach((listener) => listener())
    })
    expect(result.current.ready).toBe(true)
    expect(mocks.call).not.toHaveBeenCalled()
  }
)

it('keeps suspended and live jobs disabled, with fg guidance only for suspension', () => {
  const paneKey = 'terminal:leaf'
  const source = {
    tabId: 'terminal',
    workspaceId: subject.workspaceId,
    paneKey,
    agent: subject.agent,
    providerSessionId: 'provider-session',
    executionHostId: 'local' as const,
    ptyId: 'pty'
  }
  useAppStore.getState().setPaneForegroundAgent(paneKey, {
    agent: null,
    suspendedAgent: 'codex',
    shellForeground: true
  })
  const { result } = renderHook(() =>
    useConversationSwitchReadiness({ ...subject, direction: 'chat', source })
  )
  expect(result.current.ready).toBe(false)
  expect(result.current.explanation).toContain('If you suspended a job, run fg and exit it')
  act(() => {
    useAppStore.getState().setPaneForegroundAgent(paneKey, {
      agent: 'codex',
      shellForeground: false
    })
  })
  expect(result.current.ready).toBe(false)
  expect(result.current.explanation).toContain('Exit the job, then switch.')
  expect(result.current.explanation).not.toContain('fg')
})

it('formats real refusal categories once, with agent and next step, never raw errors or platform-wrong job control', async () => {
  const text = (reason: string, platform = 'darwin') =>
    conversationSwitchFailureText(null, { ...subject, platform }, reason)
  expect(text('messagesUnsettled')).toContain('work waiting')
  expect(text('ownerUnproven')).toContain('Restart Orca')
  expect(text('previousExitUnverifiable')).not.toContain('Restart')
  expect(text('conversationOpenInTerminal')).toContain('If you suspended a job, run fg')
  expect(text('conversationOpenInTerminal', 'win32')).not.toContain('fg')
  mocks.call.mockRejectedValue(new Error('secret raw transport/provider failure'))
  await runConversationSwitch({ ...subject, direction: 'chat' })
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    'Codex could not start in chat. Check its setup and try again.'
  )
})
