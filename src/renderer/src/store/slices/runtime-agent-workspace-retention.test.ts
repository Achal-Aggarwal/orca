import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, TEST_REPO } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { getRuntimeAgentInventoryKey } from './runtime-agent-inventory-key'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { makeFolderWorkspace } from './worktrees-slice-test-fixtures'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { retireRuntimeAgentWorkspaceInventories } from './runtime-agent-workspace-retirement'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'

const ENV = 'inventory-host'
const HOST = 'runtime:inventory-host'
const runtimeCall = vi.fn()

function reply(result: unknown) {
  return { id: 'inventory-rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

function serve(args: { method: string }) {
  return Promise.resolve(
    createCompatibleRuntimeStatusResponseIfNeeded(args) ??
      reply(
        args.method === 'preflight.detectAgents'
          ? ['codex']
          : args.method === 'preflight.refreshAgents'
            ? { agents: ['codex'] }
            : ['folderWorkspace.delete', 'projectGroup.delete'].includes(args.method)
              ? { deleted: true }
              : { removed: true }
      )
  )
}

function workspaceStore(id: string) {
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: HOST }],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id, repoId: TEST_REPO.id, hostId: HOST })]
    }
  })
  return store
}

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  const api = createStoreCascadesMockApi()
  runtimeCall.mockReset().mockImplementation(serve)
  api.runtimeEnvironments.call.mockImplementation(runtimeCall)
  vi.stubGlobal('window', {
    api: {
      ...api,
      repos: { ...api.repos, removeForHost: vi.fn().mockResolvedValue(undefined) },
      worktrees: { ...api.worktrees, forgetLocal: vi.fn().mockResolvedValue({}) },
      ephemeralVm: { listRuntimes: vi.fn().mockResolvedValue([]) }
    }
  })
})

afterEach(() => {
  createTestStore().getState().retainRuntimeDetectedAgents([])
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('retires workspace update notices on bulk purge while preserving the host default', async () => {
  runtimeCall.mockImplementation((args: { method: string }) => {
    const status = createCompatibleRuntimeStatusResponseIfNeeded(args)
    return status?.ok
      ? Promise.resolve({
          ...status,
          result: { ...status.result, capabilities: [], hostPlatform: 'win32' }
        })
      : serve(args)
  })
  const store = createTestStore()
  const ids = ['repo1::/old-host', 'folder:old-host']
  await store.getState().ensureRuntimeDetectedAgents(ENV)
  for (const id of ids) {
    await store.getState().ensureRuntimeDetectedAgents(ENV, id)
  }
  expect(Object.keys(store.getState().runtimeAgentDetectionNeedsServerUpdate)).toHaveLength(2)
  store.getState().purgeWorktreeTerminalState(ids)
  expect(store.getState().runtimeDetectedAgentIds).toEqual({ [ENV]: ['codex'] })
  expect(store.getState().runtimeAgentDetectionNeedsServerUpdate).toEqual({})
})

it.each(['failed', 'cancelled'] as const)(
  'keeps inventory when worktree deletion is %s',
  async (outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = 'repo1::/kept'
    const store = workspaceStore(id)
    await store.getState().ensureRuntimeDetectedAgents(ENV, id)
    const before = store.getState()
    runtimeCall.mockImplementation((args: { method: string }) =>
      args.method === 'worktree.rm' ? Promise.reject(new Error('failed removal')) : serve(args)
    )
    const result = await store.getState().removeWorktree(
      { id, executionHostId: HOST },
      false,
      outcome === 'cancelled'
        ? {
            assertBeforeDispatch: () => {
              throw new Error('cancelled before dispatch')
            }
          }
        : {}
    )
    expect(result.ok).toBe(false)
    expect(store.getState().runtimeDetectedAgentIds).toBe(before.runtimeDetectedAgentIds)
    expect(
      store.getState().runtimeAgentInventoryOutcome(getRuntimeAgentInventoryKey(ENV, id))
    ).toBe('successful')
    expect(runtimeCall.mock.calls.some(([args]) => args.method === 'worktree.rm')).toBe(
      outcome === 'failed'
    )
  }
)

it.each(['purge', 'forget-local'] as const)(
  'preserves a paired twin during workspace %s',
  async (path) => {
    const id = 'repo1::/twin'
    const store = workspaceStore(id)
    store.setState((s) => ({
      repos: [...s.repos, { ...TEST_REPO, executionHostId: 'runtime:other-host' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [
          ...s.worktreesByRepo[TEST_REPO.id],
          makeWorktree({ id, repoId: TEST_REPO.id, hostId: 'runtime:other-host' })
        ]
      }
    }))
    await store.getState().ensureRuntimeDetectedAgents(ENV)
    await store.getState().ensureRuntimeDetectedAgents(ENV, id)
    await store.getState().ensureRuntimeDetectedAgents('other-host', id)
    if (path === 'purge') {
      store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id, hostId: HOST })])
    } else {
      expect(
        await store
          .getState()
          .removeWorktree({ id, executionHostId: HOST }, false, { mode: 'forget-local' })
      ).toEqual({
        ok: true
      })
    }
    expect(store.getState().runtimeDetectedAgentIds).toEqual({
      [ENV]: ['codex'],
      [getRuntimeAgentInventoryKey('other-host', id)]: ['codex']
    })
  }
)

it.each(['deleted', 'rejected', 'failed'] as const)(
  'retires only successfully %s folder inventory',
  async (outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const folder: FolderWorkspace = { ...makeFolderWorkspace(), executionHostId: HOST }
    const id = `folder:${folder.id}`
    const store = createTestStore()
    store.setState({ folderWorkspaces: [folder] })
    await store.getState().ensureRuntimeDetectedAgents(ENV, id)
    runtimeCall.mockImplementation((args: { method: string }) =>
      args.method === 'folderWorkspace.delete'
        ? outcome === 'failed'
          ? Promise.reject(new Error('failed folder removal'))
          : Promise.resolve(reply({ deleted: outcome === 'deleted' }))
        : serve(args)
    )
    expect(await store.getState().deleteFolderWorkspace(folder.id)).toBe(outcome === 'deleted')
    expect(store.getState().runtimeDetectedAgentIds[getRuntimeAgentInventoryKey(ENV, id)]).toEqual(
      outcome === 'deleted' ? undefined : ['codex']
    )
  }
)

it.each([
  ['detect', 'success'],
  ['detect', 'failure'],
  ['refresh', 'success'],
  ['refresh', 'failure']
] as const)('fences late %s %s and permits same-path replacement', async (kind, outcome) => {
  const id = 'repo1::/recreated'
  const store = workspaceStore(id)
  const oldReply = Promise.withResolvers<ReturnType<typeof reply>>()
  const started = Promise.withResolvers<void>()
  const method = kind === 'detect' ? 'preflight.detectAgents' : 'preflight.refreshAgents'
  runtimeCall.mockImplementation((args: { method: string }) => {
    if (args.method === method) {
      runtimeCall.mockImplementation(serve)
      started.resolve()
      return oldReply.promise
    }
    return serve(args)
  })
  const retired =
    kind === 'detect'
      ? store.getState().ensureRuntimeDetectedAgents(ENV, id)
      : store.getState().refreshRuntimeDetectedAgents(ENV, id)
  await started.promise
  store.getState().purgeWorktreeTerminalState([id])
  const key = getRuntimeAgentInventoryKey(ENV, id)
  expect(store.getState().runtimeDetectedAgentIds[key]).toBeUndefined()
  expect(store.getState().isDetectingRuntimeAgents[key]).toBeUndefined()
  expect(store.getState().isRefreshingRuntimeAgents[key]).toBeUndefined()
  expect(store.getState().runtimeAgentInventoryOutcome(key)).toBe('pending')
  const replacement = store.getState().ensureRuntimeDetectedAgents(ENV, id)
  expect(replacement).not.toBe(retired)
  await expect(replacement).resolves.toEqual(['codex'])
  if (outcome === 'failure') {
    oldReply.reject(new Error('retired probe failed'))
  } else {
    oldReply.resolve(reply(kind === 'detect' ? ['claude'] : { agents: ['claude'] }))
  }
  await retired
  expect(store.getState().runtimeDetectedAgentIds[key]).toEqual(['codex'])
  expect(store.getState().runtimeAgentInventoryOutcome(key)).toBe('successful')
})

it('preserves record identities when retiring an absent workspace', async () => {
  const store = createTestStore()
  await store.getState().ensureRuntimeDetectedAgents(ENV)
  expect(retireRuntimeAgentWorkspaceInventories(store.getState(), [{ id: 'absent' }])).toEqual({})
})

it('uses the original paired host when the purge attributes its workspace to nested SSH', async () => {
  const id = 'repo1::/nested-twin'
  const store = workspaceStore(id)
  store.setState({
    worktreesByRepo: {
      [TEST_REPO.id]: [ENV, 'other-host'].map((runtimeOwnerEnvironmentId) =>
        makeWorktree({
          id,
          repoId: TEST_REPO.id,
          hostId: 'ssh:private-target',
          runtimeOwnerEnvironmentId
        })
      )
    }
  })
  await store.getState().ensureRuntimeDetectedAgents(ENV, id)
  await store.getState().ensureRuntimeDetectedAgents('other-host', id)
  store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id, hostId: HOST })])
  expect(store.getState().runtimeDetectedAgentIds).toEqual({
    [getRuntimeAgentInventoryKey('other-host', id)]: ['codex']
  })
})

it('retires one paired folder while its same-id folder survives on another host', async () => {
  const folder: FolderWorkspace = { ...makeFolderWorkspace(), executionHostId: HOST }
  const id = `folder:${folder.id}`
  const store = createTestStore()
  store.setState({
    folderWorkspaces: [folder, { ...folder, executionHostId: 'runtime:other-host' }]
  })
  await store.getState().ensureRuntimeDetectedAgents(ENV, id)
  await store.getState().ensureRuntimeDetectedAgents('other-host', id)
  expect(await store.getState().deleteFolderWorkspace(folder.id, { executionHostId: HOST })).toBe(
    true
  )
  expect(store.getState().runtimeDetectedAgentIds).toEqual({
    [getRuntimeAgentInventoryKey('other-host', id)]: ['codex']
  })
})

it('resolves a paired inventory from an SSH-qualified purge target', async () => {
  const id = 'repo1::/ssh-alias'
  const store = workspaceStore(id)
  store.setState({
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({
          id,
          repoId: TEST_REPO.id,
          hostId: 'ssh:private-target',
          runtimeOwnerEnvironmentId: ENV
        }),
        makeWorktree({ id, repoId: TEST_REPO.id, hostId: 'runtime:other-host' })
      ]
    }
  })
  await store.getState().ensureRuntimeDetectedAgents(ENV, id)
  await store.getState().ensureRuntimeDetectedAgents('other-host', id)
  store
    .getState()
    .purgeWorktreeTerminalState([hostWorktreeTarget({ id, hostId: 'ssh:private-target' })])
  expect(store.getState().runtimeDetectedAgentIds).toEqual({
    [getRuntimeAgentInventoryKey('other-host', id)]: ['codex']
  })
})

it.each([true, false])(
  'retires a removed project twin only after successful removal=%s',
  async (success) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = 'repo1::/removed-project'
    const store = workspaceStore(id)
    store.setState((s) => ({
      repos: [...s.repos, { ...TEST_REPO, executionHostId: 'runtime:other-host' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [
          ...s.worktreesByRepo[TEST_REPO.id],
          makeWorktree({ id, repoId: TEST_REPO.id, hostId: 'runtime:other-host' })
        ]
      }
    }))
    await store.getState().ensureRuntimeDetectedAgents(ENV, id)
    await store.getState().ensureRuntimeDetectedAgents('other-host', id)
    if (!success) {
      runtimeCall.mockImplementation((args: { method: string }) =>
        args.method === 'repo.rm'
          ? Promise.reject(new Error('failed project removal'))
          : serve(args)
      )
    }
    await store.getState().removeProject(TEST_REPO.id, { hostId: HOST })
    expect(store.getState().runtimeDetectedAgentIds[getRuntimeAgentInventoryKey(ENV, id)]).toEqual(
      success ? undefined : ['codex']
    )
    expect(
      store.getState().runtimeDetectedAgentIds[getRuntimeAgentInventoryKey('other-host', id)]
    ).toEqual(['codex'])
  }
)

it('retires a deleted group subtree without retiring other folders or same-id twins', async () => {
  const group: ProjectGroup = {
    id: 'group-1',
    name: 'Group',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId: HOST
  }
  const folder: FolderWorkspace = { ...makeFolderWorkspace(), executionHostId: HOST }
  const child: FolderWorkspace = { ...folder, id: 'child-folder', projectGroupId: 'child-group' }
  const kept: FolderWorkspace = { ...folder, id: 'kept-folder', projectGroupId: 'kept-group' }
  const store = createTestStore()
  store.setState({
    projectGroups: [
      group,
      { ...group, id: 'child-group', parentGroupId: group.id },
      { ...group, executionHostId: 'runtime:other-host' }
    ],
    folderWorkspaces: [folder, child, kept, { ...folder, executionHostId: 'runtime:other-host' }]
  })
  for (const row of [folder, child, kept]) {
    await store.getState().ensureRuntimeDetectedAgents(ENV, `folder:${row.id}`)
  }
  await store.getState().ensureRuntimeDetectedAgents('other-host', `folder:${folder.id}`)
  expect(await store.getState().deleteProjectGroup(group.id, { hostId: HOST })).toBe(true)
  expect(store.getState().runtimeDetectedAgentIds).toEqual({
    [getRuntimeAgentInventoryKey(ENV, `folder:${kept.id}`)]: ['codex'],
    [getRuntimeAgentInventoryKey('other-host', `folder:${folder.id}`)]: ['codex']
  })
})

it.each([true, false])(
  'retires absent folders only after an accepted catalog fetch=%s',
  async (success) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const folder: FolderWorkspace = { ...makeFolderWorkspace(), executionHostId: HOST }
    const id = `folder:${folder.id}`
    const store = createTestStore()
    store.setState({
      folderWorkspaces: [folder, { ...folder, executionHostId: 'runtime:other-host' }]
    })
    await store.getState().ensureRuntimeDetectedAgents(ENV, id)
    await store.getState().ensureRuntimeDetectedAgents('other-host', id)
    runtimeCall.mockImplementation((args: { method: string }) =>
      args.method === 'folderWorkspace.list'
        ? success
          ? Promise.resolve(reply({ folderWorkspaces: [] }))
          : Promise.reject(new Error('offline'))
        : serve(args)
    )
    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: ENV })
    expect(store.getState().runtimeDetectedAgentIds[getRuntimeAgentInventoryKey(ENV, id)]).toEqual(
      success ? undefined : ['codex']
    )
    expect(
      store.getState().runtimeDetectedAgentIds[getRuntimeAgentInventoryKey('other-host', id)]
    ).toEqual(['codex'])
  }
)

it('ignores an obsolete empty folder catalog after a newer fetch keeps the folder', async () => {
  const folder: FolderWorkspace = { ...makeFolderWorkspace(), executionHostId: HOST }
  const id = `folder:${folder.id}`
  const store = createTestStore()
  store.setState({ folderWorkspaces: [folder] })
  await store.getState().ensureRuntimeDetectedAgents(ENV, id)
  const oldReply = Promise.withResolvers<ReturnType<typeof reply>>()
  const started = Promise.withResolvers<void>()
  runtimeCall.mockImplementation((args: { method: string }) => {
    if (args.method !== 'folderWorkspace.list') {
      return serve(args)
    }
    runtimeCall.mockImplementation((next: { method: string }) =>
      next.method === 'folderWorkspace.list'
        ? Promise.resolve(reply({ folderWorkspaces: [folder] }))
        : serve(next)
    )
    started.resolve()
    return oldReply.promise
  })
  const obsolete = store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: ENV })
  await started.promise
  await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: ENV })
  const inventories = store.getState().runtimeDetectedAgentIds
  oldReply.resolve(reply({ folderWorkspaces: [] }))
  await obsolete
  expect(store.getState().runtimeDetectedAgentIds).toBe(inventories)
  expect(store.getState().runtimeDetectedAgentIds[getRuntimeAgentInventoryKey(ENV, id)]).toEqual([
    'codex'
  ])
})

it.each([10, 100])(
  'releases settled inventories after deleting %i paired workspaces',
  async (count) => {
    const store = createTestStore()
    const worktrees = Array.from({ length: count }, (_, index) =>
      makeWorktree({
        id: `${TEST_REPO.id}::/workspace/retention-${count}-${index}`,
        repoId: TEST_REPO.id,
        hostId: HOST
      })
    )
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: HOST }],
      worktreesByRepo: { [TEST_REPO.id]: worktrees }
    })
    await store.getState().ensureRuntimeDetectedAgents(ENV)
    for (const worktree of worktrees) {
      await store.getState().ensureRuntimeDetectedAgents(ENV, worktree.id)
    }
    expect(Object.keys(store.getState().runtimeDetectedAgentIds)).toHaveLength(count + 1)
    for (const worktree of worktrees) {
      expect(
        await store.getState().removeWorktree({ id: worktree.id, executionHostId: HOST }, false)
      ).toEqual({ ok: true })
    }
    expect(store.getState().worktreesByRepo[TEST_REPO.id]).toEqual([])
    expect(Object.keys(store.getState().runtimeDetectedAgentIds)).toHaveLength(1)
    expect(store.getState().runtimeDetectedAgentIds).toEqual({ [ENV]: ['codex'] })
    expect(store.getState().isDetectingRuntimeAgents).toEqual({ [ENV]: false })
    expect(store.getState().isRefreshingRuntimeAgents).toEqual({ [ENV]: false })
    for (const worktree of worktrees) {
      expect(
        store.getState().runtimeAgentInventoryOutcome(getRuntimeAgentInventoryKey(ENV, worktree.id))
      ).toBe('pending')
    }
  }
)
