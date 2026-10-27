import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as RetirementModule from '@/runtime/structured-agent-session-tab-retirement'
import type * as LaunchRegistryModule from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import type * as StatusFeedModule from '@/runtime/structured-agent-session-status-feed'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { structuredAgentSessionAgentStatus } from '../../../../shared/structured-agent-session-agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { makeTabGroup, makeUnifiedTab } from '../../store/slices/store-session-test-harness'
import { createWorkspaceTabCloseCommands } from './workspace-tab-close-commands'

const { retire, launchLifecycle, observation, conversationName } = vi.hoisted(() => ({
  retire: vi.fn(),
  launchLifecycle: vi.fn<() => 'pending' | null>(),
  observation: { live: true, starting: false },
  conversationName: vi.fn<() => string | null>()
}))

vi.mock('@/runtime/structured-agent-session-tab-retirement', async (importOriginal) => ({
  ...(await importOriginal<typeof RetirementModule>()),
  beginStructuredAgentSessionTabClose: retire
}))
vi.mock(
  '@/lib/agent-session/launch/structured-agent-session-launch-registry',
  async (original) => ({
    ...(await original<typeof LaunchRegistryModule>()),
    getStructuredAgentSessionLaunchLifecycle: launchLifecycle
  })
)
vi.mock('@/runtime/structured-agent-session-status-feed', async (original) => ({
  ...(await original<typeof StatusFeedModule>()),
  getStructuredAgentSessionStatusFeed: () => ({
    getNamingSnapshot: () => new Map([['chat', { conversationName: conversationName() }]]),
    getSessionObservation: () => (observation.live ? 'live' : 'unverifiable'),
    getSnapshot: () =>
      new Map([['chat', { hostExecutionPhase: observation.starting ? 'starting' : 'idle' }]])
  })
}))

const initialState = useAppStore.getInitialState()
const settings = getDefaultSettings('/tmp/pr-34236')
const tab = makeUnifiedTab({
  id: 'chat-tab',
  entityId: 'chat',
  worktreeId: 'folder',
  groupId: 'group',
  executionHostId: 'local',
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  label: 'Codex task'
})
const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
const clearDraft = vi.fn()
const emptied = vi.fn()

function status(state: AgentStatusState): void {
  useAppStore.setState({
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        stateHistory: [],
        state,
        agentType: 'codex',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1
      }
    }
  })
}

function close(skipRunningProcessConfirm = false): void {
  createWorkspaceTabCloseCommands({ worktreeId: tab.worktreeId, groupTabs: [tab] }).closeItem(
    tab.id,
    { whenEmptied: emptied, skipRunningProcessConfirm }
  )
}

function pending() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

describe('interactive native chat close admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    launchLifecycle.mockReturnValue(null)
    conversationName.mockReturnValue(null)
    observation.live = true
    observation.starting = false
    useAppStore.setState(initialState, true)
    useAppStore.setState({
      unifiedTabsByWorktree: { [tab.worktreeId]: [tab] },
      groupsByWorktree: {
        [tab.worktreeId]: [
          makeTabGroup({
            id: tab.groupId,
            worktreeId: tab.worktreeId,
            activeTabId: tab.id,
            tabOrder: [tab.id],
            recentTabIds: [tab.id]
          })
        ]
      },
      clearNativeChatLaunchDraft: clearDraft,
      recordFeatureInteraction: vi.fn(),
      settings: { ...settings, skipCloseTerminalWithRunningProcessConfirm: false }
    })
  })

  afterEach(() => {
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    useAppStore.setState(initialState, true)
  })

  it.each(['working', 'blocked', 'waiting'] as const)(
    'holds %s work before retirement; Cancel preserves it and confirm closes',
    (state) => {
      status(state)
      const before = useAppStore.getState()
      close()
      expect(pending()).toMatchObject({
        terminalTabId: tab.id,
        copyKind: 'chat-agent',
        tabLabel: tab.label
      })
      expect(retire).not.toHaveBeenCalled()
      expect(clearDraft).not.toHaveBeenCalled()
      expect(emptied).not.toHaveBeenCalled()
      useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
      expect(useAppStore.getState()).toBe(before)

      close()
      useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
      expect(retire).toHaveBeenCalledTimes(1)
      expect(retire).toHaveBeenCalledWith(expect.objectContaining({ sessionId: tab.entityId }))
      expect(clearDraft).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().unifiedTabsByWorktree[tab.worktreeId]).toEqual([])
      expect(emptied).toHaveBeenCalledTimes(1)
    }
  )

  it('warns for monitoring-only background work after the foreground finishes', () => {
    const projected = structuredAgentSessionAgentStatus({
      status: 'idle',
      childWork: [{ kind: 'command', state: 'monitoring' }]
    })
    expect(projected).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    status(projected.state)
    close()
    expect(pending()).not.toBeNull()
    expect(retire).not.toHaveBeenCalled()
  })

  it.each(['pending launch', 'host starting', 'unobservable'] as const)(
    'warns for %s before a projected status exists',
    (caseName) => {
      if (caseName === 'pending launch') {
        launchLifecycle.mockReturnValue('pending')
      }
      if (caseName === 'host starting') {
        observation.starting = true
      }
      if (caseName === 'unobservable') {
        observation.live = false
      }
      close()
      expect(pending()).not.toBeNull()
      useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
      expect(retire).not.toHaveBeenCalled()
      expect(clearDraft).not.toHaveBeenCalled()
      expect(emptied).not.toHaveBeenCalled()
    }
  )

  it('uses the chat name displayed from the host naming feed', () => {
    status('working')
    conversationName.mockReturnValue('Investigate production regression')
    close()
    expect(pending()).toMatchObject({ tabLabel: 'Investigate production regression' })
    expect(retire).not.toHaveBeenCalled()
  })

  it('keeps consent enabled before settings load', () => {
    status('working')
    useAppStore.setState({ settings: null })
    close()
    expect(pending()).not.toBeNull()
    expect(retire).not.toHaveBeenCalled()
  })

  it('closes a known live idle chat without asking', () => {
    status('done')
    close()
    expect(pending()).toBeNull()
    expect(retire).toHaveBeenCalledTimes(1)
    expect(emptied).toHaveBeenCalledTimes(1)
  })

  it.each(['setting', 'confirmed bulk'] as const)('honors the existing %s opt-out', (caseName) => {
    status('working')
    if (caseName === 'setting') {
      useAppStore.setState({
        settings: {
          ...settings,
          skipCloseTerminalWithRunningProcessConfirm: true
        }
      })
    }
    close(caseName === 'confirmed bulk')
    expect(pending()).toBeNull()
    expect(retire).toHaveBeenCalledTimes(1)
  })

  it('shares duplicate requests and retires once with the shipped synchronous layout', () => {
    status('working')
    close()
    close()
    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(pending()).toBeNull()
    expect(retire).toHaveBeenCalledTimes(1)
    expect(clearDraft).toHaveBeenCalledTimes(1)
    expect(emptied).toHaveBeenCalledTimes(1)
  })
})
