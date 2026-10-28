import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { LayoutApplyParams } from '../../../shared/rpc-contract/workspace-layout-params'
import { publishAgentLaunchTab } from './agent-launch-tab-publication'
import { registerTerminalPresentationIpcBridge } from '@/hooks/ipc-events/terminal-presentation-ipc-bridge'

const mocks = vi.hoisted(() => {
  const storeRef: { current: unknown } = { current: null }
  return {
    storeRef,
    callRuntimeRpc: vi.fn(async (_target: unknown, _method: string, _params: unknown) => ({
      ok: true,
      result: {}
    }))
  }
})

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.storeRef.current
  }
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'
const LEAF = '11111111-1111-4111-8111-111111111111'

let store: ReturnType<typeof createTestStore>

beforeEach(() => {
  mocks.callRuntimeRpc.mockClear()
  store = createTestStore()
  mocks.storeRef.current = store
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
})

describe('a background agent tab in a layout-owner build', () => {
  it('binds the published reserved pane without another layout RPC', () => {
    const onLifecycle = vi.fn<typeof window.api.automations.onTerminalLifecycleRequest>(
      () => () => {}
    )
    const respond = vi.fn<typeof window.api.automations.respondTerminalLifecycle>()
    const onCreate = vi.fn<typeof window.api.ui.onCreateTerminal>(() => () => {})
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      api: {
        ...window.api,
        automations: { onTerminalLifecycleRequest: onLifecycle, respondTerminalLifecycle: respond },
        ui: {
          onLaunchRecipe: () => () => {},
          onCreateTerminal: onCreate,
          onRequestTerminalTabMount: () => () => {},
          replyTerminalCreate: vi.fn()
        }
      }
    })
    const unsubs: (() => void)[] = []
    registerTerminalPresentationIpcBridge(unsubs)
    try {
      const lifecycle = onLifecycle.mock.calls[0][0]
      const correlation = {
        requestId: 'arm',
        registrationId: 'registration',
        runId: 'run',
        operationId: 'operation',
        serviceGeneration: 'generation',
        documentEpoch: null
      }
      const target = {
        worktreeId: WT,
        tabId: 'tab-run',
        leafId: LEAF,
        paneKey: makePaneKey('tab-run', LEAF)
      }
      lifecycle({ ...correlation, operation: 'arm', target })
      expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({ disposition: 'armed' }))
      const epoch = respond.mock.calls[0][0].documentEpoch
      const published = publishAgentLaunchTab({
        requestId: 'publish',
        worktreeId: WT,
        tabId: target.tabId,
        leafId: LEAF,
        launchAgent: 'codex',
        viewMode: 'terminal',
        viewer: 'none'
      })
      expect(published).toMatchObject({ tabId: target.tabId, created: true })
      onCreate.mock.calls[0][0]({
        requestId: 'materialize',
        worktreeId: WT,
        tabId: target.tabId,
        leafId: LEAF,
        ptyId: 'pty-run',
        presentation: 'background',
        surfaceOwner: false,
        agentLaunchViewer: 'none'
      })
      lifecycle({
        ...correlation,
        requestId: 'bind',
        documentEpoch: epoch,
        operation: 'bind',
        ptyId: 'pty-run',
        incarnationId: 'original',
        hostId: 'local'
      })
      expect(respond).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ...correlation,
          requestId: 'bind',
          documentEpoch: epoch,
          disposition: 'bound'
        })
      )
      expect(
        store.getState().tabsByWorktree[WT].find((tab) => tab.id === target.tabId)?.ptyId
      ).toBe('pty-run')
      const layout = store.getState().terminalLayoutsByTabId[target.tabId]
      expect(layout?.root).toEqual({ type: 'leaf', leafId: LEAF })
      expect(layout?.ptyIdsByLeafId).toEqual({ [LEAF]: 'pty-run' })
      expect(store.getState().ptyIdsByTabId[target.tabId]).toEqual(['pty-run'])
      expect(store.getState().tabsByWorktree[WT]).toHaveLength(1)
      expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
      expect(LayoutApplyParams.parse(mocks.callRuntimeRpc.mock.calls[0][2]).command).toEqual(
        expect.objectContaining({ type: 'createTerminalTab', leafId: LEAF })
      )
    } finally {
      unsubs.forEach((release) => release())
      vi.unstubAllGlobals()
    }
  })
})
