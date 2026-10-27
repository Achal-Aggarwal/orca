// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { publishAgentLaunchTab } from '@/lib/agent-launch-tab-publication'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { registerSessionTabIpcBridge } from '@/hooks/ipc-events/session-tab-ipc-bridge'
import { buildMobileSessionTabSnapshots } from '@/runtime/sync-runtime-graph/mobile-session-snapshots'
import { mobilePublicationEpoch } from '@/runtime/sync-runtime-graph/graph-state'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import {
  createHarness,
  WORKTREE_ID
} from '../../src/main/runtime/__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { createMobileCreateTestNotifier } from '../../src/main/runtime/orca-runtime-test-scenario-builders.spec'
import { electronMocks } from '../../src/main/runtime/orca-runtime-test-mocks.spec'
import { setRuntimeDesktopSurface } from '../../src/main/runtime/runtime-desktop-surface'
import { electronRuntimeDesktopSurface } from '../../src/main/host/electron-runtime-desktop-surface'
import { createRestTestRig } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionSwitchDeadline } from '../../src/shared/agent-session-switch-execution'
import { structuredAgentSessionTabId } from '../../src/shared/structured-agent-session-projection'
import type {
  SessionTabCloseRequest,
  SessionTabCloseResponse
} from '../../src/shared/session-tab-close'

const { receipts } = vi.hoisted(() => ({ receipts: vi.fn(async () => {}) }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: receipts
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

afterEach(() => {
  setRuntimeDesktopSurface(null)
  electronMocks.BrowserWindow.fromId.mockReset()
  resetLocalStructuredSessionVersionForTests()
  vi.clearAllMocks()
})

it.each(['saved', 'empty'] as const)(
  'diagnoses focused %s desktop retirement through real IPC, visibility and inventory owners',
  async (content) => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    createTabsSliceMockApi()
    const state = () => useAppStore.getState()
    state().setActiveWorktree(WORKTREE_ID)
    const neighbor = state().createTab(WORKTREE_ID)
    const source = state().createUnifiedTab(WORKTREE_ID, 'agent-session', {
      id: structuredAgentSessionTabId(HOST_TEST_SESSION),
      entityId: HOST_TEST_SESSION,
      agentSessionAgent: 'codex'
    })
    useAppStore.setState({
      unifiedTabsByWorktree: {
        ...state().unifiedTabsByWorktree,
        [WORKTREE_ID]: state().unifiedTabsByWorktree[WORKTREE_ID]!.map((tab) =>
          tab.id === source.id ? { ...tab, sortOrder: 0 } : tab
        )
      }
    })
    state().activateTab(source.id)
    const order = () =>
      state().groupsByWorktree[WORKTREE_ID]!.find((group) => group.id === source.groupId)!.tabOrder
    expect(order()).toEqual([neighbor.id, source.id])
    const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
    const deadline = agentSessionSwitchDeadline()
    const unsubs: (() => void)[] = []
    try {
      const params = createTestParams(undefined, {
        surfaceTabId: source.id,
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: WORKTREE_ID,
          workspaceKind: 'git-worktree'
        }
      })
      expect(await rig.host.create(CREATE_TEST_CALLER, params)).toMatchObject({ ok: true })
      if (content === 'saved') {
        expect(await rig.host.switchToChat(HOST_TEST_SESSION)).toMatchObject({ ok: true })
        const events = rig.adapter.acquire.mock.calls[0]?.[0].events
        if (!events) {
          throw new Error('Expected the host acquisition event sink')
        }
        events.appendItem(
          { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'saved', ordinal: 1 },
          hostTestMessage('Saved conversation'),
          { turnScope: { kind: 'thread' } }
        )
        await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
      }
      await rig.host.switchToTerminal(HOST_TEST_SESSION, deadline)
      setStructuredAgentSessionHost(rig.host)
      await rig.store.setSessionTabVisibility(HOST_TEST_SESSION, true, source.id)
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, setBackgroundThrottling: () => {} }
      })
      setRuntimeDesktopSurface({
        showNotification: () => false,
        findWindowById: electronRuntimeDesktopSurface.findWindowById,
        onIpc: () => {},
        removeIpcListener: () => {}
      })
      const harness = createHarness()
      harness.removeVictimFromInventory()
      harness.editSession(() => buildWorkspaceSessionPayload(state()))
      const publishGraph = () =>
        harness.runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          rendererGeneration: mobilePublicationEpoch,
          conditionalSwitchProjection: 1,
          mobileSessionTabs: buildMobileSessionTabSnapshots(state(), false)
        })
      publishGraph()
      harness.runtime.projectStructuredAgentSessionTab({
        workspaceId: WORKTREE_ID,
        sessionId: HOST_TEST_SESSION,
        agent: 'codex',
        activate: false
      })
      const before = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      let onClose!: (request: SessionTabCloseRequest) => void
      const pending = new Map<string, (applied: boolean) => void>()
      const responses: SessionTabCloseResponse[] = []
      Object.assign(window.api.ui, {
        onCloseSessionTab: () => () => {},
        onMoveSessionTab: () => () => {},
        onSessionTabCloseRequest: (listener: typeof onClose) => {
          onClose = listener
          return () => {}
        },
        respondSessionTabClose: (response: SessionTabCloseResponse) => {
          responses.push(response)
          pending.get(response.requestId)!(response.switchApplied === true)
          pending.delete(response.requestId)
        }
      })
      registerSessionTabIpcBridge(unsubs)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const phases: string[] = []
      harness.runtime.setNotifier({
        ...createMobileCreateTestNotifier(vi.fn()),
        closeSessionTab: async (tabId, worktreeId, switchProjection) => {
          const requestId = `close-${phases.length}`
          phases.push(switchProjection?.phase ?? 'ordinary')
          const answer = new Promise<boolean>((resolve) => {
            pending.set(requestId, resolve)
            onClose({ requestId, tabId, worktreeId, switchProjection })
          })
          if (switchProjection?.phase === 'retire') {
            entered.resolve()
            await release.promise
          }
          return answer
        }
      })
      const restore = vi.fn(async () => {
        await rig.store.setSessionTabVisibility(HOST_TEST_SESSION, true, source.id)
      })
      const retire = harness.runtime.captureSessionSwitchRetirement(
        WORKTREE_ID,
        HOST_TEST_SESSION,
        source.id,
        rig.host.captureSwitchWork(HOST_TEST_SESSION, deadline),
        restore,
        {
          invocationId: 'desktop-diagnostic',
          generation: 'desktop-generation',
          sessionId: HOST_TEST_SESSION,
          tabId: source.id,
          phase: 'prepare'
        }
      )
      const destination = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
      publishAgentLaunchTab({
        requestId: 'destination',
        operationId: 'desktop-diagnostic',
        worktreeId: WORKTREE_ID,
        tabId: destination,
        leafId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        launchAgent: 'codex',
        viewMode: 'terminal',
        viewer: 'focus-window',
        placement: { groupId: source.groupId!, afterTabId: source.id }
      })
      expect(state().activeTabId).toBe(destination)
      expect(order()).toEqual([neighbor.id, source.id, destination])
      publishGraph()
      const closing = retire()
      const retired = await Promise.race([
        entered.promise.then(() => 'ipc'),
        closing.then(() => 'settled')
      ])
      try {
        if (retired === 'ipc') {
          expect(rig.store.listVisibleSessionIds()).not.toContain(HOST_TEST_SESSION)
          applyStructuredSessionTabSnapshots([before], undefined, { reacceptCurrentVersion: true })
        }
      } finally {
        release.resolve()
        await closing
      }
      expect(await closing).toBe(true)
      expect(phases).toEqual(['prepare', 'retire'])
      expect(responses.map((response) => response.switchApplied)).toEqual([true, true])
      expect(restore).not.toHaveBeenCalled()
      const inventory = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      applyStructuredSessionTabSnapshots([inventory], undefined, { reacceptCurrentVersion: true })
      expect(rig.store.getVisibleSessionTabIndex().sessionIds).not.toContain(HOST_TEST_SESSION)
      expect(
        inventory.tabs.some(
          (tab) => tab.type === 'agent-session' && tab.sessionId === HOST_TEST_SESSION
        )
      ).toBe(false)
      expect(state().unifiedTabsByWorktree[WORKTREE_ID]!.some((tab) => tab.id === source.id)).toBe(
        false
      )
      expect(order()).toEqual([neighbor.id, destination])
      expect(receipts.mock.calls.flat()).not.toContainEqual(
        expect.objectContaining({
          execution: expect.objectContaining({
            receipt: expect.objectContaining({ retained: true })
          })
        })
      )
    } finally {
      unsubs.forEach((unsubscribe) => unsubscribe())
      setStructuredAgentSessionHost(null)
      deadline.dispose()
      await rig.dispose()
    }
  }
)
