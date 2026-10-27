import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RetirementModule from '@/runtime/structured-agent-session-tab-retirement'
import type {
  AgentSessionHistoryResult,
  AgentSessionStatusSummary,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/store-session-test-harness'
import { createWorkspaceTabCloseCommands } from '../tab-group/workspace-tab-close-commands'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'
import {
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage
} from './structured-agent-session-message-sender'
import { getStructuredAgentSessionPendingSends } from './structured-agent-session-pending-sends'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  subscribeStatus: vi.fn(),
  retire: vi.fn(),
  clearDraft: vi.fn(),
  call: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  ensureRuntimeEnvironmentCompatible: async () => {},
  callRuntimeRpc: mocks.history,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', async (original) => ({
  ...(await original<typeof RetirementModule>()),
  beginStructuredAgentSessionTabClose: mocks.retire
}))
const SESSION = 'session-1'
const target = { kind: 'local' } as const
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve()
  }
}
const chat = makeUnifiedTab({
  id: 'chat',
  entityId: SESSION,
  worktreeId: 'folder',
  groupId: 'group',
  contentType: 'agent-session',
  executionHostId: 'local',
  customLabel: 'My task'
})
const idlePage: AgentSessionHistoryResult = {
  ok: true,
  page: {
    sessionId: SESSION,
    epoch: 'e',
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: { epoch: 'e', sequence: 1 } },
    hasOlder: false,
    hasNewer: false,
    latestTurn: null,
    working: false,
    actionablePromptIds: [],
    backgroundTasks: null,
    nextQueuedMessageId: null
  }
}
const idleSummary: AgentSessionStatusSummary = {
  sessionId: SESSION,
  workspaceId: 'folder',
  agent: 'codex',
  status: 'idle',
  latestPrompt: '',
  updatedAt: 1
}
let freshStatus = idleSummary
let releaseFeed = (): void => {}
const emptied = vi.fn()
const pendingClose = () =>
  useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
function closeChat(skipRunningProcessConfirm = false): void {
  createWorkspaceTabCloseCommands({ worktreeId: 'folder', groupTabs: [chat] }).closeItem(chat.id, {
    whenEmptied: emptied,
    skipRunningProcessConfirm
  })
}
async function prepareAdmission(): Promise<void> {
  vi.clearAllMocks()
  freshStatus = idleSummary
  useAppStore.setState({
    unifiedTabsByWorktree: { folder: [chat] },
    groupsByWorktree: {
      folder: [
        makeTabGroup({
          id: 'group',
          worktreeId: 'folder',
          activeTabId: chat.id,
          tabOrder: [chat.id]
        })
      ]
    },
    settings: {
      ...getDefaultSettings('/tmp/pr-34236'),
      skipCloseTerminalWithRunningProcessConfirm: false
    },
    clearNativeChatLaunchDraft: mocks.clearDraft
  })
  mocks.history.mockReset().mockResolvedValue(idlePage)
  mocks.subscribeStatus.mockReset().mockImplementation((_target, emit) => {
    emit({ type: 'snapshot', sessions: [freshStatus] })
    return Promise.resolve({ unsubscribe: vi.fn() })
  })
  releaseFeed = getStructuredAgentSessionStatusFeed(target).activate()
  await flush()
}

describe('close admission through the real sender, owner and feed', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    await prepareAdmission()
    noteStructuredAgentSessionFence(SESSION, 4)
  })
  afterEach(() => {
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    resetStructuredAgentSessionSendsForTests()
    releaseFeed()
    resetStructuredAgentSessionStatusFeedsForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  it('warns during issued send and accepted handoff before a fresh idle answer', async () => {
    const answer = Promise.withResolvers<AgentSessionMutationResult<AgentSessionSendResult>>()
    mocks.call.mockReturnValue(answer.promise)
    const sent = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'continue' })
    await flush()
    expect(getStructuredAgentSessionPendingSends(SESSION)).toMatchObject([{ issued: true }])
    closeChat()
    expect(pendingClose()).not.toBeNull()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    answer.resolve({
      ok: true,
      replayed: false,
      fence: 4,
      cursor: { epoch: 'e', sequence: 2 },
      value: {
        clientMessageId: sent!.clientMessageId,
        submission: {
          clientMessageId: sent!.clientMessageId,
          fence: 4,
          payloadFingerprint: 'send',
          dispatchState: 'accepted',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: 2
        }
      }
    })
    expect(await sent!.outcome).toBe('recorded')
    expect(getStructuredAgentSessionPendingSends(SESSION)).toEqual([])
    mocks.history.mockResolvedValueOnce({ ...idlePage, page: { ...idlePage.page, working: true } })
    closeChat()
    await flush()
    expect(pendingClose()).not.toBeNull()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    expect(mocks.retire).not.toHaveBeenCalled()
    await flush()
    closeChat()
    await flush()
    expect(pendingClose()).toBeNull()
    expect(mocks.retire).toHaveBeenCalledOnce()
  })
  it.each(['active', 'idle', 'HTTP', 'null settings', 'opt-out', 'bulk'])(
    '%s uses existing consent and retirement',
    async (mode) => {
      if (mode !== 'idle') {
        mocks.subscribeStatus.mock.calls[0][1]({
          type: 'status',
          session: { ...idleSummary, status: 'working' }
        })
      }
      if (mode === 'null settings') {
        useAppStore.setState({ settings: null })
      }
      if (mode === 'opt-out') {
        useAppStore.setState({
          settings: {
            ...getDefaultSettings('/tmp/pr-34236'),
            skipCloseTerminalWithRunningProcessConfirm: true
          }
        })
      }
      if (mode === 'HTTP') {
        vi.stubGlobal('crypto', undefined)
      }
      const before = useAppStore.getState()
      closeChat(mode === 'bulk')
      await flush()
      if (mode === 'active' || mode === 'HTTP' || mode === 'null settings') {
        expect(pendingClose()).toMatchObject({ copyKind: 'chat-agent', tabLabel: 'My task' })
        useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
        expect(useAppStore.getState()).toBe(before)
        expect(mocks.retire).not.toHaveBeenCalled()
        expect(mocks.clearDraft).not.toHaveBeenCalled()
        expect(emptied).not.toHaveBeenCalled()
        await flush()
        closeChat()
        useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
      } else {
        expect(pendingClose()).toBeNull()
      }
      expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: SESSION })
      )
      expect(emptied).toHaveBeenCalledOnce()
      expect(useAppStore.getState().unifiedTabsByWorktree.folder).toEqual([])
      expect(mocks.history).toHaveBeenCalledTimes(mode === 'idle' ? 1 : 0)
    }
  )
  // Reduced wire shapes from the executed producer cases; the completed one-row tail is identical.
  it.each(['idle', 'prompt', 'unanswered', 'eligible queue', 'unlisted child'])(
    'legacy %s warns without a new status subscription',
    async (kind) => {
      const page = {
        ...idlePage.page,
        hasOlder: true,
        latestTurn: {
          itemId: 'codex:thread-1:turn-1:1',
          observedAt: 1_000,
          turn: { turnId: 'turn-1', state: 'completed' }
        },
        working: undefined,
        actionablePromptIds: undefined,
        nextQueuedMessageId: kind === 'eligible queue' ? 'eligible-card' : null,
        backgroundTasks:
          kind === 'unlisted child'
            ? { state: 'monitoring', supportsStopAll: false, children: [], incomplete: true }
            : null
      } satisfies AgentSessionHistoryResult['page']
      mocks.history.mockResolvedValue({ ok: true, page })
      freshStatus = {
        ...idleSummary,
        status: kind === 'prompt' ? 'attention' : kind === 'unanswered' ? 'working' : 'idle'
      }
      closeChat()
      await vi.advanceTimersByTimeAsync(0)
      expect(pendingClose()).not.toBeNull()
      expect(mocks.retire).not.toHaveBeenCalled()
      expect(mocks.history).toHaveBeenCalledOnce()
      expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
    }
  )
  it.each(['read error', 'unsupported old host', 'deadline'])(
    '%s warns instead of silently closing or hanging',
    async (kind) => {
      mocks.history.mockReset()
      if (kind === 'deadline') {
        mocks.history.mockReturnValue(new Promise(() => {}))
      } else {
        const error = new RuntimeRpcCallError({
          id: 'history',
          ok: false,
          error: {
            code: kind === 'unsupported old host' ? 'method_not_found' : 'internal',
            message: kind
          }
        })
        mocks.history.mockRejectedValue(error)
        if (kind === 'unsupported old host') {
          mocks.subscribeStatus.mockRejectedValue(error)
        }
      }
      closeChat()
      if (kind === 'deadline') {
        await vi.advanceTimersByTimeAsync(1_999)
        expect(pendingClose()).toBeNull()
        expect(mocks.retire).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
      }
      await flush()
      expect(pendingClose()).not.toBeNull()
      expect(mocks.retire).not.toHaveBeenCalled()
    }
  )
})
