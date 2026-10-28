// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeProjectGroup } from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import * as runtime from '../../../shared/project-execution-runtime'
import * as folderHost from '../../../shared/folder-workspace-execution-host'
import * as projectIndex from '@/lib/local-runtime-project-index'
import * as preflight from '@/lib/local-preflight-context'
import {
  loadWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} from '@/lib/windows-terminal-capabilities'
import { useLocalAgentPreflightContext } from './useLocalAgentPreflightContext'
import { useAppStore } from '@/store'
import {
  makeWorktree,
  makeFolderWorkspace,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { useNewTabAgentMenuRows } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import type { Project } from '../../../shared/project-types'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { useDetectedAgents, type AgentDetectionTarget } from './useDetectedAgents'

const initialState = useAppStore.getInitialState()
const detectAgents = vi.fn()
const updateProject = vi.fn()
const refreshAgents = vi.fn()

beforeEach(() => {
  resetWindowsTerminalCapabilitiesForTests()
  useAppStore.setState(initialState, true)
  useAppStore.getState().clearLocalDetectedAgents()
  detectAgents.mockReset().mockResolvedValue(['codex'])
  refreshAgents.mockReset().mockResolvedValue({ agents: ['codex'] })
  updateProject.mockReset()
  Object.assign(window, {
    api: {
      preflight: { detectAgents, refreshAgents },
      projects: { update: updateProject },
      platform: { get: () => ({ platform: 'win32' }) }
    }
  })
})

afterEach(() => {
  resetWindowsTerminalCapabilitiesForTests()
  cleanup()
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(initialState, true)
})

const localTargets: AgentDetectionTarget[] = [
  { kind: 'local' },
  { kind: 'local', worktreeId: FLOATING_TERMINAL_WORKTREE_ID, contextKey: 'host' }
]

it.each(localTargets)('restarts an invalidated first probe for $worktreeId', async (target) => {
  let finishOldProbe: (agents: string[]) => void = () => {}
  detectAgents.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      finishOldProbe = resolve
    })
  )
  const { result } = renderHook(() => useDetectedAgents(target))
  expect(result.current).toMatchObject({ detectedIds: null, isLoading: true })

  await act(async () => {
    useAppStore.getState().clearLocalDetectedAgents()
  })
  expect(detectAgents).toHaveBeenCalledTimes(2)
  expect(result.current).toMatchObject({ detectedIds: ['codex'], isLoading: false })

  await act(async () => {
    finishOldProbe(['claude'])
  })
  expect(result.current.detectedIds).toEqual(['codex'])
})

it('retargets a mounted first load when the project switches to WSL', async () => {
  const worktree = makeWorktree({ id: 'wt1', repoId: TEST_REPO.id, path: 'C:\\project' })
  const repos = [{ ...TEST_REPO, path: worktree.path }]
  const catalog = projectHostSetupProjectionFromRepos(repos)
  const project: Project = {
    ...catalog.projects[0],
    localWindowsRuntimePreference: { kind: 'windows-host' }
  }
  useAppStore.setState({
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: worktree.id,
    repos,
    endpointProjects: [project],
    endpointProjectHostSetups: [...catalog.setups],
    worktreesByRepo: { [TEST_REPO.id]: [worktree] },
    settings: {
      ...getDefaultSettings('/home/test'),
      localWindowsRuntimeDefault: { kind: 'windows-host' }
    }
  })
  let finishHostProbe: (agents: string[]) => void = () => {}
  detectAgents.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      finishHostProbe = resolve
    })
  )
  const { result } = renderHook(() => ({
    detection: useDetectedAgents({ kind: 'local' }),
    menu: useNewTabAgentMenuRows(worktree.id, false, { kind: 'local' })
  }))
  expect(result.current.detection.isLoading).toBe(true)
  expect(result.current.menu.state).toBe('loading')
  const preference = { kind: 'wsl', distro: 'Ubuntu' } as const
  updateProject.mockResolvedValue({ ...project, localWindowsRuntimePreference: preference })

  await act(async () => {
    await expect(
      useAppStore
        .getState()
        .updateProject(project.id, { localWindowsRuntimePreference: preference }, 'local')
    ).resolves.toBe(true)
  })
  expect(detectAgents).toHaveBeenCalledTimes(2)
  expect(detectAgents).toHaveBeenLastCalledWith(
    expect.objectContaining({
      projectRuntime: expect.objectContaining({
        runtime: expect.objectContaining({ kind: 'wsl', distro: 'Ubuntu' })
      })
    })
  )
  expect(result.current.detection).toMatchObject({ detectedIds: ['codex'], isLoading: false })
  expect(result.current.menu).toMatchObject({
    state: 'settled',
    rows: expect.arrayContaining([expect.objectContaining({ agent: 'codex' })])
  })

  await act(async () => {
    finishHostProbe(['claude'])
  })
  expect(result.current.detection.detectedIds).toEqual(['codex'])
})

it.each(localTargets)(
  'keeps a failed first inventory unknown until Retry for $worktreeId',
  async (target) => {
    detectAgents.mockRejectedValue(new Error('probe failed'))
    const { result, rerender } = renderHook(() => useDetectedAgents(target))
    await act(async () => {})
    expect(result.current).toMatchObject({
      detectedIds: null,
      isLoading: false,
      detectionFailed: true
    })
    expect(
      useAppStore
        .getState()
        .readLocalAgentInventory(target.kind === 'local' ? target.worktreeId : undefined)
    ).toEqual({ ids: null, state: 'failed' })
    rerender()
    await act(async () => {})
    expect(detectAgents).toHaveBeenCalledTimes(1)
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current).toMatchObject({ detectedIds: ['codex'], detectionFailed: false })
  }
)

it('bounds repeated inventory work at N/10N and renders only the observed context', async () => {
  const context = await import('@/lib/local-preflight-context')
  const { localAgentInventoryContextKey } = await import('@/lib/local-preflight-context-key')
  const resolution = vi.spyOn(runtime, 'resolveProjectExecutionRuntime')
  const selection = vi.spyOn(preflight, 'selectLocalAgentPreflightInput')
  const candidates = vi.spyOn(folderHost, 'findFolderWorkspaceCandidateRepos')
  let indexing = false
  let indexRows = 0
  const getIndexed = projectIndex.getIndexedLocalRuntimeProject
  const indexReads = vi
    .spyOn(projectIndex, 'getIndexedLocalRuntimeProject')
    .mockImplementation((...args) => {
      indexing = true
      try {
        return getIndexed(...args)
      } finally {
        indexing = false
      }
    })
  const measured: number[] = []
  for (const count of [10, 100]) {
    let projectRows = 0
    let workspaceRows = 0
    let folderRows = 0
    const repos = Array.from({ length: 1000 }, (_, index) => ({
      ...TEST_REPO,
      id: `repo-${index}`,
      path: `C:\\project-${index}`
    }))
    repos[0] = { ...repos[0], projectGroupId: 'folder-group' }
    const catalog = projectHostSetupProjectionFromRepos(repos)
    const projects = (rows: readonly Project[]) =>
      rows.map(
        (project) =>
          new Proxy(project, {
            get(row, key, receiver) {
              if (key === 'id' || key === 'sourceRepoIds') {
                projectRows += 1
                if (indexing) {
                  indexRows += 1
                }
              }
              return Reflect.get(row, key, receiver)
            }
          })
      )
    const worktrees = repos.slice(-count - 1).map(
      (repo) =>
        new Proxy(
          makeWorktree({
            id: `${repo.id}::${repo.path}`,
            repoId: repo.id,
            path: repo.path
          }),
          {
            get(row, key, receiver) {
              if (key === 'id') {
                workspaceRows += 1
              }
              return Reflect.get(row, key, receiver)
            }
          }
        )
    )
    useAppStore.setState({
      repos,
      endpointProjects: projects(
        catalog.projects.map((project) => ({
          ...project,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }))
      ),
      folderWorkspaces: [
        new Proxy(
          makeFolderWorkspace({
            id: 'folder',
            projectGroupId: 'folder-group',
            folderPath: 'C:\\folder',
            executionHostId: 'local'
          }),
          {
            get(row, key, receiver) {
              if (key === 'id') {
                folderRows += 1
              }
              return Reflect.get(row, key, receiver)
            }
          }
        )
      ],
      projectGroups: [{ ...makeProjectGroup(), id: 'folder-group' }],
      endpointProjectHostSetups: [...catalog.setups],
      worktreesByRepo: Object.fromEntries(worktrees.map((wt) => [wt.repoId, [wt]])),
      settings: getDefaultSettings('/tmp')
    })
    const keys = worktrees.map((wt) =>
      localAgentInventoryContextKey(
        context.getLocalAgentPreflightContext(useAppStore.getState(), undefined, undefined, wt.id)
      )
    )
    useAppStore.setState({
      localDetectedAgentIdsByContext: Object.fromEntries(keys.map((key) => [key, ['claude']]))
    })
    let reads = 0
    const failures = (entries: Record<string, boolean>) =>
      new Proxy(entries, {
        get(target, key, receiver) {
          reads += 1
          return Reflect.get(target, key, receiver)
        }
      })
    useAppStore.setState({ localAgentInventoryFailedByContext: failures({}) })
    const renders = Array<number>(count).fill(0)
    const mounted = worktrees.slice(0, count).map((wt, index) =>
      renderHook(() => {
        renders[index] += 1
        return useDetectedAgents({ kind: 'local', worktreeId: wt.id })
      })
    )
    let folderRenders = 0
    const folder = renderHook(() => {
      folderRenders += 1
      return useLocalAgentPreflightContext('folder:folder')
    })
    await act(async () => {})
    expect(folder.result.current?.projectRuntime).toMatchObject({ status: 'resolved' })
    renders.fill(0)
    folderRenders = 0
    reads = projectRows = workspaceRows = indexRows = folderRows = 0
    resolution.mockClear()
    selection.mockClear()
    candidates.mockClear()
    const unrelated = [
      () => useAppStore.setState({ isDetectingAgents: false }),
      () =>
        useAppStore.setState({
          detectedWorktreesByRepo: { otherHost: makeDetectedResult('otherHost', []) }
        }),
      () => useAppStore.setState({ remoteDetectedAgentIds: { anotherHost: ['codex'] } }),
      () =>
        useAppStore.setState({
          localAgentInventoryFailedByContext: failures({ anotherContext: true })
        }),
      () =>
        useAppStore.setState((s) => ({
          settings: { ...(s.settings ?? getDefaultSettings('/tmp')), terminalFontSize: 15 }
        }))
    ]
    for (const publish of unrelated) {
      await act(async () => {
        publish()
      })
      expect(renders).toEqual(Array(count).fill(0))
      expect(folderRenders).toBe(0)
      expect(resolution).not.toHaveBeenCalled()
      expect(projectRows).toBe(0)
      expect(indexRows).toBe(0)
      expect(folderRows).toBe(0)
      expect(candidates).not.toHaveBeenCalled()
    }
    measured.push(reads)
    const inputReads = selection.mock.calls.length
    expect(inputReads).toBeLessThanOrEqual(6 * (count + 1))
    // The producer is real; only its disk/RPC persistence boundary is replaced.
    const persistence = await import('@/store/slices/worktrees/metadata/worktree-meta-persist')
    const persist = vi.spyOn(persistence, 'persistWorktreeMeta').mockResolvedValue()
    const previousSource = useAppStore.getState().worktreesByRepo
    await act(async () => {
      useAppStore.getState().bumpWorktreeActivity(worktrees[count].id)
    })
    expect(useAppStore.getState().worktreesByRepo).not.toBe(previousSource)
    expect(persist).toHaveBeenCalledOnce()
    persist.mockRestore()
    expect(renders).toEqual(Array(count).fill(0))
    expect(folderRenders).toBe(0)
    expect(projectRows).toBe(0)
    expect(folderRows).toBe(0)
    expect(resolution).not.toHaveBeenCalled()
    expect(candidates).not.toHaveBeenCalled()
    // Shared worktree-index rebuild plus the producer's own reads, never M rebuilds.
    expect(workspaceRows).toBeLessThanOrEqual(8 * (count + 1))
    const activityRows = workspaceRows
    await act(async () => {
      useAppStore.setState((s) => ({
        folderWorkspaces: s.folderWorkspaces.map((entry) => ({ ...entry, lastActivityAt: 42 }))
      }))
    })
    expect(candidates).not.toHaveBeenCalled()
    expect(resolution).not.toHaveBeenCalled()
    expect(folderRenders).toBe(0)
    expect(folderRows).toBeGreaterThan(0)
    expect(folderRows).toBeLessThanOrEqual(4)
    const folderIndexRows = folderRows
    await act(async () => {
      useAppStore.setState((s) => ({
        endpointProjects: projects(s.endpointProjects.map((project) => ({ ...project })))
      }))
    })
    expect(projectRows).toBeGreaterThan(1000)
    expect(projectRows).toBeLessThanOrEqual(8000)
    const rebuiltProjectRows = indexRows
    const catalogAndCopyRows = projectRows - indexRows
    expect(indexRows).toBeGreaterThan(0)
    expect(indexRows).toBeLessThanOrEqual(5000)
    expect(resolution).not.toHaveBeenCalled()
    expect(renders).toEqual(Array(count).fill(0))
    // A real selected runtime changes only its owner; the new catalog index is shared.
    await act(async () => {
      useAppStore.setState((s) => ({
        endpointProjects: projects(
          s.endpointProjects.map((project) =>
            project.id === catalog.projects[999 - count].id
              ? { ...project, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' } }
              : project
          )
        )
      }))
    })
    expect(resolution.mock.calls.length).toBeGreaterThan(0)
    expect(
      resolution.mock.calls.every(([input]) => input.projectId === catalog.projects[999 - count].id)
    ).toBe(true)
    expect(detectAgents).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectRuntime: expect.objectContaining({
          runtime: expect.objectContaining({ distro: 'Debian' })
        })
      })
    )
    expect(mounted[0].result.current.detectedIds).toEqual(['codex'])
    expect(renders.slice(1)).toEqual(Array(count - 1).fill(0))
    expect(folderRenders).toBe(0)
    // Restore the original key without relying on the acquisition result.
    await act(async () => {
      useAppStore.setState({
        endpointProjects: projects(
          catalog.projects.map((project) => ({
            ...project,
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          }))
        )
      })
    })
    resolution.mockClear()
    renders.fill(0)
    process.stdout.write(
      `${JSON.stringify({ metric: 'context-selected-work', consumers: count, projects: 1000, inputReads, expensiveIrrelevant: 0, projectIndexRows: rebuiltProjectRows, catalogAndCopyRows, activityRows, folderIndexRows, unaffectedRenders: 0 })}\n`
    )
    await act(async () => {
      useAppStore.setState({
        localAgentInventoryFailedByContext: failures({ [keys[0]]: true })
      })
    })
    expect(renders[0]).toBeGreaterThan(0)
    expect(renders.slice(1)).toEqual(Array(count - 1).fill(0))
    expect(mounted[0].result.current).toMatchObject({
      detectedIds: ['claude'],
      detectionFailed: true
    })
    await act(async () => {
      useAppStore.setState({ isRefreshingLocalAgentsByContext: { [keys[0]]: true } })
    })
    expect(mounted[0].result.current.detectionFailed).toBe(false)
    await act(async () => {
      useAppStore.setState({ isRefreshingLocalAgentsByContext: {} })
    })
    expect(mounted[0].result.current.detectionFailed).toBe(true)
    expect(resolution).not.toHaveBeenCalled()
    // Same selector follows real folder path, owner and candidate-cardinality changes.
    await act(async () => {
      useAppStore.setState((s) => ({
        endpointProjects: s.endpointProjects.map((project, index) =>
          index === 0 ? { ...project, localWindowsRuntimePreference: undefined } : project
        ),
        folderWorkspaces: s.folderWorkspaces.map((entry) => ({
          ...entry,
          folderPath: String.raw`\\wsl$\Debian\folder`
        }))
      }))
    })
    expect(folder.result.current?.wslDistro).toBe('Debian')
    expect(candidates).toHaveBeenCalled()
    await act(async () => {
      useAppStore.setState((s) => ({
        folderWorkspaces: s.folderWorkspaces.map((entry) => ({
          ...entry,
          executionHostId: 'ssh:other'
        }))
      }))
    })
    expect(folder.result.current).toBeUndefined()
    await act(async () => {
      useAppStore.setState((s) => ({
        folderWorkspaces: s.folderWorkspaces.map((entry) => ({
          ...entry,
          executionHostId: 'local'
        }))
      }))
    })
    expect(folder.result.current?.wslDistro).toBe('Debian')
    await act(async () => {
      useAppStore.setState((s) => ({
        repos: s.repos.map((repo, index) =>
          index === 1 ? { ...repo, projectGroupId: 'folder-group' } : repo
        )
      }))
    })
    expect(folder.result.current).toBeUndefined()
    folder.unmount()
    mounted.forEach((hook) => hook.unmount())
  }
  expect(measured[0]).toBeGreaterThanOrEqual(10)
  expect(measured[1]).toBeLessThanOrEqual(10 * measured[0])
  process.stdout.write(
    `${JSON.stringify({ metric: 'inventory-notification-reads', populations: [10, 100], projectCount: 1000, reads: measured, irrelevantContextResolutions: 0 })}\n`
  )
  resolution.mockRestore()
  selection.mockRestore()
  candidates.mockRestore()
  indexReads.mockRestore()
})

it('reads newly cached capabilities with the same AppState without acquiring an inventory', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    }
  })
  Object.assign(window.api, {
    wsl: {
      isAvailable: vi.fn().mockResolvedValue(false),
      listDistros: vi.fn().mockResolvedValue([])
    },
    pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
    gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
    runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
  })
  const { result, rerender } = renderHook(() => useLocalAgentPreflightContext())
  expect(result.current?.projectRuntime).toMatchObject({
    status: 'resolved',
    runtime: { distro: 'Ubuntu' }
  })
  const state = useAppStore.getState()
  await act(async () => {
    await loadWindowsTerminalCapabilities()
  })
  expect(useAppStore.getState()).toBe(state)
  rerender()
  expect(result.current?.projectRuntime).toMatchObject({
    status: 'repair-required',
    repair: { reason: 'wsl-unavailable' }
  })
  expect(detectAgents).not.toHaveBeenCalled()
  expect(refreshAgents).not.toHaveBeenCalled()
})
