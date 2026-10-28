import { beforeEach, vi } from 'vitest'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import type { Project } from '../../../shared/project-types'

export const mockCreateTab = vi.fn()
export function queuedStartups() {
  return mockCreateTab.mock.calls.flatMap((call) => call[3]?.pendingStartup ?? [])
}
export const mockSetActiveTabType = vi.fn()
export const mockSetTabViewMode = vi.fn()
export const mockSetTabBarOrder = vi.fn()
export const mockSetAgentStatus = vi.fn()
export const mockPasteDraftWhenAgentReady = vi.fn()
export const mockSeedNativeChatLaunchPrompt = vi.fn()
export const mockSeedNativeChatLaunchDraft = vi.fn()
export const mockMarkNativeChatLaunchPromptFailed = vi.fn()
export const mockTrack = vi.fn()
export const mockToastMessage = vi.fn()
export const mockWaitForAgentReady = vi.fn()

export const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const initialProjects: Pick<Project, 'id' | 'localWindowsRuntimePreference'>[] = [
  { id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' } }
]

export const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  } as {
    agentCmdOverrides: Record<string, string>
    agentDefaultArgs: Record<string, string>
    agentDefaultEnv: Record<string, Record<string, string>>
    activeRuntimeEnvironmentId: string | null
    terminalWindowsShell?: string
    experimentalNativeChat?: boolean
    nativeChatSessionOptions?: Record<
      string,
      { model?: string; valuesByModel?: Record<string, Record<string, string | boolean>> }
    >
  },
  projects: initialProjects,
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  sshConnectionStates: new Map([
    ['ssh-a', { status: 'connected', remotePlatform: 'linux' }],
    ['ssh-target-1', { status: 'connected', remotePlatform: 'linux' }]
  ]),
  transientClearedAgentStatusConnectionIds: {} as Record<string, true>,
  sshStateByEnvironment: new Map(),
  runtimeStatusByEnvironmentId: new Map([['web-runtime', { status: { hostPlatform: 'linux' } }]]),
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  },
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  tabsByWorktree: {
    'wt-1': [{ id: 'tab-1' }]
  },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {} as Record<
    string,
    { activeLeafId: string | null; ptyIdsByLeafId?: Record<string, string> }
  >,
  ptyIdsByTabId: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  closeTab: vi.fn(),
  setActiveTabType: mockSetActiveTabType,
  setTabViewMode: mockSetTabViewMode,
  setTabBarOrder: mockSetTabBarOrder,
  setAgentStatus: mockSetAgentStatus,
  seedNativeChatLaunchPrompt: mockSeedNativeChatLaunchPrompt,
  seedNativeChatLaunchDraft: mockSeedNativeChatLaunchDraft,
  markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

export const mockToastError = vi.fn()

vi.mock('sonner', () => ({
  toast: { message: mockToastMessage, error: mockToastError }
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn(
    (_stored, termIds: string[], editorIds: string[], browserIds: string[]) => [
      ...termIds,
      ...editorIds,
      ...browserIds
    ]
  )
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

// Cover window-planned launches/paste here; AI-button host launches share delivery but have separate ownership tests.
vi.mock('@/lib/launch-agent-new-tab-host-route', () => ({
  newTabPromptLaunchesThroughHost: () => false,
  launchNewTabPromptThroughHost: vi.fn()
}))

vi.mock('@/lib/agent-ready-wait', () => ({
  waitForAgentReady: mockWaitForAgentReady
}))

vi.mock('@/lib/telemetry', () => ({
  track: mockTrack,
  tuiAgentToAgentKind: (agent: string) => agent
}))

export const mockCreateWebRuntimeSessionTerminal = vi.fn()
export const mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft = vi.fn()
export const mockIsWebRuntimeSessionActive = vi.fn(() => false)

vi.mock('@/runtime/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: async (args: unknown) => ({
    outcome: await mockCreateWebRuntimeSessionTerminal(args)
  })
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: mockCreateWebRuntimeSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft:
    mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive
}))
vi.mock('../../../shared/terminal-surface-id', () => ({
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

export const COMMAND_CODE_CLICK = {
  requestId: 'command-code-click',
  agent: 'command-code',
  worktreeId: 'wt-1'
} as const

beforeEach(() => {
  vi.clearAllMocks()
  setLocalRuntimeCapabilitiesForTests([])
  mockIsWebRuntimeSessionActive.mockReturnValue(false)
  mockCreateWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
  mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft.mockResolvedValue({ status: 'created' })
  store.activeRepoId = 'repo-1'
  store.activeWorktreeId = 'wt-1'
  store.settings = {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null
  }
  store.projects = [
    {
      id: 'repo-1',
      localWindowsRuntimePreference: { kind: 'inherit-global' }
    }
  ]
  store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
  store.sshConnectionStates = new Map([
    ['ssh-a', { status: 'connected', remotePlatform: 'linux' }],
    ['ssh-target-1', { status: 'connected', remotePlatform: 'linux' }]
  ])
  store.transientClearedAgentStatusConnectionIds = {}
  store.worktreesByRepo = {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  }
  store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
  store.openFiles = []
  store.browserTabsByWorktree = {}
  store.tabBarOrderByWorktree = {}
  store.terminalLayoutsByTabId = {}
  store.ptyIdsByTabId = {}
  mockCreateTab.mockReturnValue({ id: 'tab-1' })
  mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  mockWaitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
})
