// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
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
  const resolution = vi.spyOn(context, 'getLocalAgentPreflightContext')
  const measured: number[] = []
  for (const count of [10, 100]) {
    const repos = Array.from({ length: 1000 }, (_, index) => ({
      ...TEST_REPO,
      id: `repo-${index}`,
      path: `C:\\project-${index}`
    }))
    const catalog = projectHostSetupProjectionFromRepos(repos)
    const worktrees = repos.slice(-count).map((repo) =>
      makeWorktree({
        id: `${repo.id}::${repo.path}`,
        repoId: repo.id,
        path: repo.path
      })
    )
    useAppStore.setState({
      repos,
      endpointProjects: catalog.projects.map((project) => ({
        ...project,
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })),
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
    const mounted = worktrees.map((wt, index) =>
      renderHook(() => {
        renders[index] += 1
        return useDetectedAgents({ kind: 'local', worktreeId: wt.id })
      })
    )
    await act(async () => {})
    renders.fill(0)
    reads = 0
    resolution.mockClear()
    await act(async () => {
      useAppStore.setState({ isDetectingAgents: false })
    })
    expect(renders).toEqual(Array(count).fill(0))
    await act(async () => {
      useAppStore.setState({
        remoteDetectedAgentIds: { anotherHost: ['codex'] },
        localAgentInventoryFailedByContext: failures({ anotherContext: true })
      })
    })
    expect(renders).toEqual(Array(count).fill(0))
    expect(resolution).not.toHaveBeenCalled()
    measured.push(reads)
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
    mounted.forEach((hook) => hook.unmount())
  }
  expect(measured[0]).toBeGreaterThanOrEqual(10)
  expect(measured[1]).toBeLessThanOrEqual(10 * measured[0])
  process.stdout.write(
    `${JSON.stringify({ metric: 'inventory-notification-reads', populations: [10, 100], projectCount: 1000, reads: measured, contextResolutions: 0 })}\n`
  )
  resolution.mockRestore()
})
