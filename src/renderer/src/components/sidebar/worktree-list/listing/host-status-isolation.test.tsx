// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useRepoSshGateResolver } from '@/hooks/use-repo-ssh-gate-resolver'
import { useProjectHeaderHostContexts } from '../viewport/use-project-header-host-contexts'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'
import { useSidebarSectionRows } from './use-section-rows'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { RuntimeHostStatusSnapshot } from '../../../../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/runtime-environments'
import type { Repo } from '../../../../../../shared/repo-types'
import type * as SshGate from '@/lib/repo-ssh-connection'
import type { SshConnectionStatus } from '../../../../../../shared/ssh-types'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import type * as DeviceVisibility from '../../../../../../shared/workspace-creator-visibility'
import type * as Registry from '../../../../../../shared/execution-host-registry'
import type * as RowPlan from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import type * as Visibility from '../../visible-worktrees'

const counts = vi.hoisted(() => ({ devices: 0, registry: 0, plan: 0, visibility: 0, gates: 0 }))
vi.mock('@/lib/repo-ssh-connection', async (original) => {
  const actual = await original<typeof SshGate>()
  return {
    ...actual,
    selectRepoSshGateInput: (...args: Parameters<typeof actual.selectRepoSshGateInput>) => {
      counts.gates++
      return actual.selectRepoSshGateInput(...args)
    }
  }
})
vi.mock('../../../../../../shared/workspace-creator-visibility', async (original) => {
  const actual = await original<typeof DeviceVisibility>()
  return {
    ...actual,
    getPairedDeviceIdsByEnvironment: (
      ...args: Parameters<typeof actual.getPairedDeviceIdsByEnvironment>
    ) => {
      counts.devices++
      return actual.getPairedDeviceIdsByEnvironment(...args)
    }
  }
})
vi.mock('../../../../../../shared/execution-host-registry', async (original) => {
  const actual = await original<typeof Registry>()
  return {
    ...actual,
    buildExecutionHostRegistry: (...args: Parameters<typeof actual.buildExecutionHostRegistry>) => {
      counts.registry++
      return actual.buildExecutionHostRegistry(...args)
    }
  }
})
vi.mock('../../../../../../shared/sidebar-list/sidebar-row-plan', async (original) => {
  const actual = await original<typeof RowPlan>()
  return {
    ...actual,
    planSidebarRows: (...args: Parameters<typeof actual.planSidebarRows>) => {
      counts.plan++
      return actual.planSidebarRows(...args)
    }
  }
})
vi.mock('../../visible-worktrees', async (original) => {
  const actual = await original<typeof Visibility>()
  return {
    ...actual,
    computeVisibleWorktrees: (...args: Parameters<typeof actual.computeVisibleWorktrees>) => {
      counts.visibility++
      return actual.computeVisibleWorktrees(...args)
    }
  }
})

const initial = useAppStore.getInitialState()
function environment(id: string, pairedDeviceId?: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    pairedDeviceId,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: id
  }
}
function status(id: string): RuntimeStatus {
  const response = createCompatibleRuntimeStatusResponse(id)
  if (!response.ok) {
    throw new Error('Expected compatible status')
  }
  return response.result
}
function publish(id: string, sequence: number, patch: Partial<RuntimeHostStatusSnapshot> = {}) {
  useAppStore.getState().applyRuntimeHostStatusSnapshot({
    environmentId: id,
    pairingRevision: 1,
    sequence,
    checkedAt: sequence,
    status: status(id),
    verification: 'verified',
    transport: 'ready',
    ...patch
  })
}
function ssh(status: SshConnectionStatus, targetId = 'target') {
  return { targetId, status, error: null, reconnectAttempt: 0 }
}
const repo = { ...makeRepo(), executionHostId: 'runtime:A' as const, connectionId: 'target' }
const repoMap = new Map<string, Repo>([[repo.id, repo]])
const worktree = makeWorktree('workspace', 'Workspace', {
  runtimeOwnerEnvironmentId: 'A',
  creatorProvenance: { kind: 'paired-device', deviceId: 'mine' }
})
const visibilityArgs: Parameters<typeof useVisibleSidebarWorktrees>[0] = {
  filterState: {
    showSleepingWorkspaces: true,
    filterRepoIds: [],
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all'
  },
  sortBy: 'recent',
  sortedIds: [worktree.id],
  repoMap,
  worktreeLineageById: {},
  defaultHostId: 'local',
  agentSendTargetWorktreeId: null
}
function sectionArgs(): Parameters<typeof useSidebarSectionRows>[0] {
  return {
    groupBy: 'project',
    projectOrderBy: 'manual',
    pinnedDisplayPolicy: 'single-location',
    defaultHostId: 'local',
    worktrees: [worktree],
    repos: [repo],
    repoMap,
    worktreeMap: new Map([[worktree.id, worktree]]),
    worktreeLineageById: {},
    prCache: null,
    settings: useAppStore.getState().settings,
    workspaceStatuses: [],
    effectiveCollapsedGroups: new Set(),
    projectGrouping: { projects: [], projectHostSetups: [] },
    visibleReposForRows: [repo],
    visibleProjectGroupsForRows: [],
    visibleFolderWorkspacesForRows: [],
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    filterRepoIds: [],
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all'
  }
}
beforeEach(() => {
  useAppStore.setState(initial, true)
  useAppStore.setState({
    runtimeEnvironments: [environment('A', 'mine'), environment('B')],
    worktreesByRepo: { [repo.id]: [worktree] }
  })
  publish('A', 1, { status: { ...status('A'), pairedDeviceId: 'mine' } })
  publish('B', 1)
  useAppStore.getState().setEnvironmentSshTargetsMetadata('A', [])
  useAppStore.getState().setEnvironmentSshConnectionState('A', 'target', ssh('connected'))
  Object.assign(counts, { devices: 0, registry: 0, plan: 0, visibility: 0 })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it('isolates the repo gate and its viewport sibling, while keeping authority and scope reactive', () => {
  let renders = 0
  const contexts = { rows: [], hosts: [], repoMap }
  const { result, rerender } = renderHook(
    (repos) => {
      renders++
      return {
        gate: useRepoSshGateResolver(repos),
        contexts: useProjectHeaderHostContexts(contexts)
      }
    },
    { initialProps: repoMap }
  )
  const before = renders
  const first = result.current
  const gateBuilds = counts.gates
  act(() => useAppStore.setState({ workspaceHostOrder: ['local'] }))
  expect(counts.gates).toBe(gateBuilds)
  for (let flip = 0; flip < 10; flip++) {
    act(() => {
      publish('B', flip + 2, { verification: flip % 2 ? 'unavailable' : 'verified' })
      useAppStore
        .getState()
        .setEnvironmentSshConnectionState(
          'B',
          'target',
          ssh(flip % 2 ? 'connected' : 'disconnected')
        )
      useAppStore.setState({ sshConnectionStates: new Map([['unrelated', ssh('connected')]]) })
    })
  }
  act(() => publish('A', 2))
  expect(renders).toBe(before)
  expect(result.current).toBe(first)
  expect(first.gate(repo)).toEqual({ connectionId: 'target', status: 'connected' })
  act(() =>
    useAppStore.getState().setEnvironmentSshConnectionState('A', 'target', ssh('disconnected'))
  )
  expect(result.current.gate(repo)).toEqual({ connectionId: 'target', status: 'disconnected' })
  act(() => useAppStore.getState().markEnvironmentSshStateStale('A'))
  expect(result.current.gate(repo)).toEqual({ connectionId: null, status: null })
  act(() => useAppStore.getState().setEnvironmentSshTargetsMetadata('A', []))
  act(() =>
    useAppStore.getState().setEnvironmentSshConnectionState('A', 'target', ssh('connected'))
  )
  act(() => publish('A', 3, { status: null, verification: 'unavailable', transport: 'ready' }))
  expect(result.current.gate(repo).status).toBe('connected')
  act(() => publish('A', 4, { verification: 'checking', transport: 'connecting' }))
  expect(result.current.gate(repo)).toEqual({ connectionId: null, status: null })
  act(() => useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() }))
  expect(result.current.gate(repo)).toEqual({ connectionId: null, status: null })
  const local = { ...makeRepo(), connectionId: 'local' }
  const plain = { ...makeRepo(), id: 'plain' }
  rerender(
    new Map([
      [local.id, local],
      [plain.id, plain]
    ])
  )
  expect(result.current.gate(local)).toEqual({ connectionId: 'local', status: null })
  expect(result.current.gate(plain)).toEqual({ connectionId: null, status: null })
  act(() => useAppStore.setState({ sshConnectionStates: new Map([['local', ssh('connected')]]) }))
  expect(result.current.gate(local).status).toBe('connected')
})

it('does zero device scans while off and preserves equal identities while on, including catalog fallback', () => {
  let renders = 0
  const { result, rerender } = renderHook(
    (args) => {
      renders++
      return useVisibleSidebarWorktrees(args)
    },
    { initialProps: visibilityArgs }
  )
  const first = result.current
  const before = renders
  for (let flip = 0; flip < 10; flip++) {
    act(() => publish('B', flip + 2, { status: flip % 2 ? null : status('B') }))
  }
  expect(renders).toBe(before)
  expect(result.current).toBe(first)
  expect(counts.devices).toBe(0)
  rerender({
    ...visibilityArgs,
    filterState: { ...visibilityArgs.filterState, hideWorkspacesFromOtherDevices: true }
  })
  const on = result.current
  const onRenders = renders
  const scans = counts.visibility
  for (let flip = 0; flip < 10; flip++) {
    act(() => publish('B', flip + 12, { verification: flip % 2 ? 'unavailable' : 'verified' }))
  }
  act(() => publish('A', 2, { status: { ...status('A'), pairedDeviceId: 'mine' } }))
  expect(renders).toBe(onRenders)
  expect(result.current).toBe(on)
  expect(counts.visibility).toBe(scans)
  const deviceScans = counts.devices
  act(() => useAppStore.setState({ sshTargetLabels: new Map([['other', 'Other']]) }))
  expect(counts.devices).toBe(deviceScans)
  act(() => publish('A', 3, { status: { ...status('A'), pairedDeviceId: 'someone-else' } }))
  expect(result.current.visibleWorktrees).toEqual([])
  act(() =>
    useAppStore.setState({
      runtimeEnvironments: [environment('A', 'mine'), environment('B')],
      runtimeStatusByEnvironmentId: new Map()
    })
  )
  expect(result.current.pairedDeviceIdsByEnvironment.get('A')).toBe('mine')
  expect(result.current.visibleWorktrees).toEqual([worktree])
  act(() => useAppStore.setState({ runtimeEnvironments: [] }))
  expect(result.current.pairedDeviceIdsByEnvironment.size).toBe(0)
  rerender(visibilityArgs)
  const off = counts.devices
  act(() => useAppStore.setState({ runtimeEnvironments: [environment('A', 'new')] }))
  expect(counts.devices).toBe(off)
})

it('keeps equal host options and health-only changes out of the workspace row plan', () => {
  const args = sectionArgs()
  let renders = 0
  const { result } = renderHook(() => {
    renders++
    return useSidebarSectionRows(args)
  })
  const first = result.current
  const before = renders
  const plans = counts.plan
  for (let flip = 0; flip < 10; flip++) {
    act(() => publish('B', flip + 2, { status: { ...status('B'), liveTabCount: flip } }))
  }
  act(() => publish('A', 2, { status: { ...status('A'), liveTabCount: 99 } }))
  expect(renders).toBe(before)
  expect(result.current).toBe(first)
  expect(counts.plan).toBe(plans)
  const builds = counts.registry
  act(() => useAppStore.setState({ sshStateByEnvironment: new Map() }))
  expect(counts.registry).toBe(builds)
  act(() => publish('A', 3, { verification: 'checking', transport: 'connecting' }))
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:A')?.health).toBe(
    'connecting'
  )
  expect(counts.plan).toBe(plans)
  expect(result.current.occurrencePlan).toBe(first.occurrencePlan)
  act(() =>
    useAppStore.setState({
      runtimeEnvironments: [environment('A'), { ...environment('B'), name: 'Renamed' }]
    })
  )
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:B')?.label).toBe('Renamed')
  expect(counts.plan).toBe(plans + 1)
  act(() =>
    publish('A', 4, {
      status: { ...status('A'), capabilities: ['new-capability'], hostPlatform: 'linux' }
    })
  )
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:A')).toMatchObject({
    capabilities: ['new-capability'],
    platform: 'linux'
  })
  act(() =>
    useAppStore.setState({
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map([
        ['status-only', { status: status('status-only'), checkedAt: 1 }]
      ])
    })
  )
  expect(result.current.hostOptions.map((host) => host.id)).toContain('runtime:status-only')
  expect(result.current.hostOptions.map((host) => host.id)).not.toContain('runtime:B')
})

it('keeps compatibility, blocked guidance, aliases and diagnostic equality live in the host projection', () => {
  const control = {
    state: 'ready' as const,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    reconnectAttempt: 0,
    lastConnectedAt: 1,
    lastClose: null,
    lastError: null,
    lastRttMs: 1
  }
  publish('A', 2, { remoteControl: control })
  const args = sectionArgs()
  let renders = 0
  const { result } = renderHook(() => {
    renders++
    return useSidebarSectionRows(args)
  })
  const before = renders
  const options = result.current.hostOptions
  act(() =>
    publish('A', 3, {
      remoteControl: { ...control, lastRttMs: 99, pendingRequestCount: 10, subscriptionCount: 5 }
    })
  )
  expect(renders).toBe(before)
  expect(result.current.hostOptions).toBe(options)
  act(() => publish('A', 4, { verification: 'blocked', blockedReason: 'access-revoked' }))
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:A')).toMatchObject({
    health: 'blocked',
    blockedReason: 'access-revoked'
  })
  act(() => publish('A', 5, { status: { ...status('A'), runtimeProtocolVersion: 0 } }))
  expect(
    result.current.hostOptions.find((host) => host.id === 'runtime:A')?.compatibility
  ).toMatchObject({ kind: 'blocked', reason: 'server-too-old' })
  act(() =>
    useAppStore.setState({
      sshTargetLabels: new Map([['managed', 'My machine']]),
      runtimeEnvironments: [
        {
          ...environment('A'),
          orcadDeployment: {
            sshTargetId: 'managed',
            sshTargetGeneration: 1,
            localPort: 7001,
            remotePort: 7002
          }
        }
      ]
    })
  )
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:A')).toMatchObject({
    label: 'My machine',
    aliasHostIds: ['ssh:managed']
  })
  act(() =>
    useAppStore.setState({
      sshConnectionStates: new Map([
        [
          'managed',
          {
            ...ssh('connected', 'managed'),
            managedServer: { kind: 'relay', reason: 'orcad_unavailable' }
          }
        ]
      ])
    })
  )
  expect(result.current.hostOptions.find((host) => host.id === 'ssh:managed')).toMatchObject({
    aliasHostIds: ['runtime:A']
  })
})
