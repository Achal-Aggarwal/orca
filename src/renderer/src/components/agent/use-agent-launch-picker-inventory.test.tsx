// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { NewTabAgentMenuModel } from '../tab-bar/new-tab-agent-menu-model'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'

const mocks = vi.hoisted(() => ({ settings: vi.fn(), rpc: vi.fn(), session: vi.fn() }))
vi.mock('../settings/agent-launch-settings-transport', () => ({
  readHostAgentLaunchSettings: mocks.settings
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ settings: { agentDefaultArgs: { codex: '--desktop-only' } } }),
    { getState: () => ({}) }
  )
}))
vi.mock('@/lib/agent-launch-route-input', () => ({
  buildAgentLaunchRouteInput: () => ({ executionHostId: 'local' }),
  workspaceKindForWorktreeId: () => 'git-worktree'
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForHost: (host: string) =>
    host.startsWith('runtime:')
      ? { kind: 'environment', environmentId: host.slice(8) }
      : host === 'local'
        ? { kind: 'local' }
        : null
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.session
}))

function model(
  host = 'alpha',
  agents: ('codex' | 'claude' | 'gemini')[] = ['codex']
): NewTabAgentMenuModel {
  return {
    state: 'settled',
    rows: agents.map((agent) => ({ agent, kind: 'chat', executionHostId: `runtime:${host}` })),
    detection: {
      detectedIds: agents,
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => agents
    },
    pickerContext: {
      workspace: { kind: 'git-worktree', worktreeId: 'wt' },
      executionHostId: `runtime:${host}`,
      pairingRevision: 7,
      runtimeId: `process-${host}`,
      settings: null,
      key: host
    }
  }
}
const catalog: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  models: [
    {
      id: 'host-model',
      label: 'Host model',
      isDefault: true,
      efforts: [{ value: 'low', label: 'Low' }]
    }
  ]
}
beforeEach(() => {
  mocks.settings.mockReset().mockResolvedValue(
    projectAgentLaunchSettings({
      agentPermissionDefault: 'ask',
      agentDefaultArgs: { codex: '--host-only' }
    })
  )
  mocks.rpc.mockReset()
  mocks.session
    .mockReset()
    .mockImplementation(async (_target, method) =>
      method === 'agentSession.modelCatalog'
        ? catalog
        : { seedOptions: { model: 'host-model', effort: 'low', permissionMode: 'full-access' } }
    )
})
afterEach(cleanup)

it('reads host Arguments and remembered chat choices without leaking desktop defaults or refetching for selection', async () => {
  const menu = model()
  const hook = renderHook(
    ({ selected }: { selected?: 'codex' }) =>
      useAgentLaunchPickerInventory('wt', menu, true, selected),
    { initialProps: {} }
  )
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: true,
    terminal: {},
    structured: {}
  })
  await act(async () => {})
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: false,
    arguments: '--host-only',
    terminal: { permissionMode: 'ask' },
    structured: { model: 'host-model', options: { effort: 'low' }, permissionMode: 'full-access' },
    catalog
  })
  expect(mocks.settings).toHaveBeenCalledWith(
    { environmentId: 'alpha', pairingRevision: 7, runtimeId: 'process-alpha' },
    expect.any(AbortSignal)
  )
  hook.rerender({ selected: 'codex' })
  expect(mocks.settings).toHaveBeenCalledTimes(1)
  expect(mocks.session).toHaveBeenCalledTimes(2)
  expect(
    mocks.session.mock.calls.every(
      (call) => call[0].environmentId === 'alpha' && call[2].worktree === 'id:wt'
    )
  ).toBe(true)
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it('uses existing legacy settings and a missing optional seed on an older paired host', async () => {
  mocks.settings.mockResolvedValue(null)
  mocks.rpc.mockResolvedValue({
    settings: { agentDefaultArgs: { codex: '--sandbox workspace-write' } }
  })
  mocks.session.mockImplementation(async (_target, method) =>
    method === 'agentSession.modelCatalog' ? catalog : { supported: true }
  )
  const hook = renderHook(() => useAgentLaunchPickerInventory('wt', model(), true))
  await act(async () => {})
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: false,
    arguments: '--sandbox workspace-write',
    structured: { options: {} }
  })
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
    { kind: 'environment', environmentId: 'alpha' },
    'settings.get',
    undefined,
    expect.objectContaining({
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'process-alpha'
    })
  )
})

it('bounds open-time catalog hydration to two agents and discards responses from the previous host', async () => {
  const old = Promise.withResolvers<AgentSessionModelCatalogResult>()
  mocks.session.mockImplementation((_target, method) =>
    method === 'agentSession.modelCatalog' ? old.promise : Promise.resolve({ supported: true })
  )
  const hook = renderHook(({ menu }) => useAgentLaunchPickerInventory('wt', menu, true), {
    initialProps: { menu: model('alpha', ['codex', 'claude', 'gemini']) }
  })
  await act(async () => {})
  const catalogs = () =>
    mocks.session.mock.calls.filter((call) => call[1] === 'agentSession.modelCatalog')
  expect(catalogs()).toHaveLength(2)
  mocks.session.mockImplementation(async (_target, method) =>
    method === 'agentSession.modelCatalog' ? catalog : { supported: true }
  )
  hook.rerender({ menu: model('beta') })
  await act(async () => {})
  expect(mocks.settings.mock.calls[0][1].aborted).toBe(true)
  await act(async () => old.resolve({ ...catalog, fetchedAt: 2 }))
  expect(catalogs()).toHaveLength(3)
  expect(hook.result.current).toHaveLength(1)
  expect(hook.result.current[0].catalog).toEqual(catalog)
  expect(hook.result.current[0].rows[0].executionHostId).toBe('runtime:beta')
})
