// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { makeTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { AgentMessageSenderView } from '../../../../shared/agent-session/agent-message-presentation'
import { useAgentMessageSenderSource } from './native-chat-agent-message-sender-source'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import * as selectors from '@/components/sidebar/worktree-agent-row-selectors'
import * as rows from '@/components/sidebar/worktree-agent-rows'
import * as lineage from '@/components/dashboard/agent-row-lineage'
import * as cache from '@/components/dashboard/worktree-agent-rows-cache'
import * as structuredOwner from '@/runtime/structured-agent-session-owner'
import * as owners from '@/lib/worktree-runtime-owner'
import * as freshness from '@/components/sidebar/worktree-agent-freshness-selector'
import * as order from '@/components/sidebar/worktree-agent-row-order'
import * as senderLocation from './native-chat-agent-message-sender-label'
import * as inputs from '@/components/sidebar/worktree-card-status-inputs'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../shared/runtime-host-status'

type SenderPopulation = AppState[
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'runtimeAgentOrchestrationByPaneKey']
const initial = useAppStore.getState()
const LEAF = '11111111-1111-4111-8111-111111111111'
const renders = new Map<number, number>()
const views = new Map<number, AgentMessageSenderView>()
function status(i: number, worktreeId = 'workspace'): AgentStatusEntry {
  return {
    paneKey: `tab-${i}:${LEAF}`,
    worktreeId,
    terminalHandle: `term_${i}`,
    agentType: 'claude',
    state: 'working',
    prompt: 'work',
    updatedAt: 2_000_000,
    stateStartedAt: 2_000_000,
    stateHistory: []
  }
}
function Probe({
  id,
  sender = 0,
  workspace = 'workspace',
  remote = false
}: {
  id: number
  sender?: number
  workspace?: string
  remote?: boolean
}) {
  const value = useAgentMessageSenderView(
    {
      party: { address: `term_${sender}`, terminalHandle: `term_${sender}`, orcaSessionId: null },
      name: 'Sender'
    },
    workspace,
    remote ? { kind: 'environment', environmentId: 'remote' } : { kind: 'local' }
  )
  renders.set(id, (renders.get(id) ?? 0) + 1)
  views.set(id, value)
  return null
}
function populate(n: number) {
  useAppStore.setState({
    activeWorktreeId: 'workspace',
    activeWorkspaceExecutionHostId: 'local',
    tabsByWorktree: {
      workspace: Array.from({ length: n }, (_, i) =>
        makeTab({ id: `tab-${i}`, worktreeId: 'workspace', sortOrder: i })
      )
    },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: Object.fromEntries(
      Array.from({ length: n }, (_, i) => {
        const entry = status(i)
        return [entry.paneKey, entry]
      })
    ),
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    agentStatusEpoch: 1
  })
}
function write(i: number, update: Partial<AgentStatusEntry>) {
  const state = useAppStore.getState()
  const key = status(i).paneKey
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        [key]: { ...state.agentStatusByPaneKey[key], ...update }
      },
      agentStatusEpoch: state.agentStatusEpoch + 1
    })
  )
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  renders.clear()
  views.clear()
  populate(3)
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('isolates same-workspace cards before notification and releases leases on switch/removal/unmount', () => {
  const baseline = readStoreListenerCount() ?? 0
  const create = vi.spyOn(cache, 'createWorktreeAgentRowsCache')
  const mounted = render(
    <>
      <Probe id={0} />
      <Probe id={1} />
      <Probe id={2} sender={1} />
    </>
  )
  const before = new Map(renders)
  expect(views.get(0)).toEqual({ agentType: 'claude', dot: 'working' })
  write(1, { prompt: 'sibling tool', toolName: 'Read' })
  expect(renders).toEqual(before)
  write(1, { state: 'blocked' })
  expect(renders.get(0)).toBe(before.get(0))
  expect(renders.get(1)).toBe(before.get(1))
  expect(views.get(2)?.dot).toBe('blocked')
  const a = renders.get(0)!
  act(() => useAppStore.setState({ runtimePaneTitlesByTabId: { other: { 0: 'other host' } } }))
  act(() => useAppStore.setState({ sidebarBody: 'agents' }))
  expect(renders.get(0)).toBe(a)
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:remote' }))
  expect(views.get(0)).toEqual({})
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
  expect(views.get(0)?.dot).toBe('working')
  write(0, { agentType: 'codex' })
  expect(views.get(0)?.agentType).toBe('codex')
  write(0, { programStatus: { state: 'blocked', observedAt: 2_000_000 } })
  expect(views.get(0)?.dot).toBe('permission')
  write(0, { programStatus: undefined })
  expect(views.get(0)?.dot).toBe('working')
  vi.setSystemTime(2_000_000 + AGENT_STATUS_STALE_AFTER_MS + 1)
  act(() => useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 }))
  expect(views.get(0)?.dot).not.toBe('working')
  const entry = { ...status(0), state: 'done' as const }
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {
        [entry.paneKey]: {
          entry,
          tab: makeTab({ id: 'tab-0', worktreeId: 'workspace' }),
          worktreeId: 'workspace',
          agentType: 'claude',
          startedAt: 1
        }
      }
    })
  )
  expect(views.get(0)?.dot).toBe('done')
  mounted.rerender(<Probe id={0} sender={2} />)
  expect(views.get(0)).toEqual({})
  mounted.unmount()
  expect(readStoreListenerCount()).toBe(baseline)
  const count = create.mock.calls.length
  render(<Probe id={0} />)
  expect(create.mock.calls.length).toBeGreaterThan(count)
})

it('isolates simultaneous local/remote publications and retains disconnected sources until their last lease', () => {
  const baseline = readStoreListenerCount() ?? 0
  const other = status(9, 'remote')
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: 'remote', repoId: TEST_REPO.id, hostId: 'runtime:remote' })
      ]
    },
    tabsByWorktree: {
      ...useAppStore.getState().tabsByWorktree,
      remote: [makeTab({ id: 'tab-9', worktreeId: 'remote' })]
    },
    agentStatusByPaneKey: { ...useAppStore.getState().agentStatusByPaneKey, [other.paneKey]: other }
  })
  const build = vi.spyOn(rows, 'buildWorktreeAgentRows')
  const create = vi.spyOn(cache, 'createWorktreeAgentRowsCache')
  const mounted = render(
    <>
      <Probe id={0} />
      <Probe id={1} />
      <Probe id={2} sender={1} />
      <Probe id={3} sender={9} workspace="remote" remote />
    </>
  )
  expect(create).toHaveBeenCalledTimes(2) // Initial reads promote their existing snapshot caches.
  expect(views.get(3)?.dot).toBe('working')
  const before = new Map(renders)
  build.mockClear()
  write(0, { state: 'blocked' })
  expect(build.mock.calls.map(([args]) => args.tabs[0]?.worktreeId)).toEqual(['workspace'])
  expect(renders.get(0)).toBe(before.get(0)! + 1)
  expect(renders.get(1)).toBe(before.get(1)! + 1)
  expect(renders.get(2)).toBe(before.get(2))
  expect(renders.get(3)).toBe(before.get(3))
  const afterLocal = new Map(renders)
  build.mockClear()
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        ...useAppStore.getState().agentStatusByPaneKey,
        [other.paneKey]: { ...other, state: 'waiting' }
      },
      agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1
    })
  )
  expect(build.mock.calls.map(([args]) => args.tabs[0]?.worktreeId)).toEqual(['remote'])
  expect(renders.get(3)).toBe(afterLocal.get(3)! + 1)
  for (const id of [0, 1, 2]) {
    expect(renders.get(id)).toBe(afterLocal.get(id))
  }
  const disconnected = runtimeEnvironmentStatusFromSnapshot({
    environmentId: 'remote',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    verification: 'blocked',
    transport: 'disconnected',
    retired: true,
    status: null
  })
  act(() =>
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['remote', disconnected]]) })
  )
  build.mockClear()
  const stable = new Map(renders)
  for (let i = 0; i < 10; i++) {
    act(() => useAppStore.setState({ sidebarBody: i % 2 ? 'agents' : 'workspaces' }))
  }
  expect(build).not.toHaveBeenCalled()
  expect(renders).toEqual(stable)
  expect(create).toHaveBeenCalledTimes(2)
  for (let i = 0; i < 100; i++) {
    write(0, { prompt: `publication-${i}` })
    for (const result of create.mock.results) {
      if (result.type === 'return') {
        expect(result.value.byWorktree.size).toBe(1)
        expect(result.value.lastComputedWorktreeIds.length).toBeLessThanOrEqual(1)
        expect(result.value.seenWorktreeIds.size).toBe(1)
      }
    }
  }
  mounted.unmount()
  expect(readStoreListenerCount()).toBe(baseline)
  for (const result of create.mock.results) {
    if (result.type === 'return') {
      expect(result.value.byWorktree.size).toBe(0)
      expect(result.value.lastComputedWorktreeIds).toEqual([])
      expect(result.value.seenWorktreeIds.size).toBe(0)
    }
  }
})

it.each([100, 1000])(
  'bounds actual publication work separately from renders at %i rows/cards',
  (n) => {
    populate(n)
    let entries = 0,
      rowInputs = 0,
      lineageInputs = 0,
      comparisons = 0,
      freshnessVisits = 0,
      pointReads = 0,
      paneWrites = 0,
      handleEntries = 0
    let projecting = false
    const projector = cache.selectWorktreeAgentRowsCached
    const projections = vi
      .spyOn(cache, 'selectWorktreeAgentRowsCached')
      .mockImplementation((args) => {
        projecting = true
        try {
          return projector(args)
        } finally {
          projecting = false
        }
      })
    const locate = vi.spyOn(senderLocation, 'agentMessageSenderOwner')
    const values = Object.values
    vi.spyOn(Object, 'values').mockImplementation(
      (object: AppState['agentStatusByPaneKey'] | AppState['retainedAgentsByPaneKey']) => {
        const result = values(object)
        const state = useAppStore.getState()
        if (
          !projecting &&
          (object === state.agentStatusByPaneKey || object === state.retainedAgentsByPaneKey)
        ) {
          handleEntries += result.length
        }
        return result
      }
    )
    let fresh = false
    const originalFreshness = freshness.createWorktreeAgentFreshnessSelector
    vi.spyOn(freshness, 'createWorktreeAgentFreshnessSelector').mockImplementation((...args) => {
      const select = originalFreshness(...args)
      return (state) => {
        fresh = true
        try {
          return select(state)
        } finally {
          fresh = false
        }
      }
    })
    const arrays = new WeakMap<AgentStatusEntry[], AgentStatusEntry[]>()
    const paneMaps = new WeakSet<object>()
    const originalMapGet = Map.prototype.get
    vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key) {
      if (paneMaps.has(this)) {
        pointReads++
      }
      return originalMapGet.call(this, key)
    })
    const originalMapSet = Map.prototype.set
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value
    ) {
      if (
        typeof key === 'string' &&
        key.startsWith('tab-') &&
        typeof value === 'object' &&
        value !== null &&
        Object.hasOwn(value, 'dot')
      ) {
        paneMaps.add(this)
        paneWrites++
      }
      return originalMapSet.call(this, key, value)
    })
    const recordWork = new Map<
      string,
      { source: number; keys: number; reads: number; calls: number }
    >()
    function recordProbe<T extends object>(name: string) {
      const proxies = new WeakMap<T, T>()
      const metric = { source: 0, keys: 0, reads: 0, calls: 0 }
      recordWork.set(name, metric)
      return {
        source(record: T): T {
          return new Proxy(record, {
            get(target, key) {
              if (typeof key === 'string') {
                metric.source++
              }
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
              return target[key as keyof typeof target]
            }
          })
        },
        result(record: T): T {
          metric.calls++
          let proxy = proxies.get(record)
          if (!proxy) {
            proxy = new Proxy(record, {
              ownKeys(target) {
                metric.keys += Reflect.ownKeys(target).length
                return Reflect.ownKeys(target)
              },
              get(target, key) {
                if (typeof key === 'string') {
                  metric.reads++
                }
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
                return target[key as keyof typeof target]
              }
            })
            proxies.set(record, proxy)
          }
          return proxy
        }
      }
    }
    const titles =
      recordProbe<ReturnType<typeof inputs.selectRuntimePaneTitlesForWorktree>>('titles')
    const ptys = recordProbe<ReturnType<typeof inputs.selectLivePtyIdsForWorktree>>('ptys')
    const layouts =
      recordProbe<ReturnType<typeof selectors.selectTerminalLayoutsForWorktree>>('layouts')
    const foreground =
      recordProbe<ReturnType<typeof inputs.selectPaneForegroundAgentsForWorktree>>('foreground')
    const titleSelect = inputs.selectRuntimePaneTitlesForWorktree
    const ptySelect = inputs.selectLivePtyIdsForWorktree
    const layoutSelect = selectors.selectTerminalLayoutsForWorktree
    const foregroundSelect = inputs.selectPaneForegroundAgentsForWorktree
    vi.spyOn(inputs, 'selectRuntimePaneTitlesForWorktree').mockImplementation((...args) =>
      titles.result(titleSelect(...args))
    )
    vi.spyOn(inputs, 'selectLivePtyIdsForWorktree').mockImplementation((...args) =>
      ptys.result(ptySelect(...args))
    )
    vi.spyOn(selectors, 'selectTerminalLayoutsForWorktree').mockImplementation((...args) =>
      layouts.result(layoutSelect(...args))
    )
    vi.spyOn(inputs, 'selectPaneForegroundAgentsForWorktree').mockImplementation((...args) =>
      foreground.result(foregroundSelect(...args))
    )
    useAppStore.setState({
      runtimePaneTitlesByTabId: titles.source(
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`tab-${i}`, { 0: `Pane ${i}` }]))
      ),
      ptyIdsByTabId: ptys.source(
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`tab-${i}`, [`pty-${i}`]]))
      ),
      terminalLayoutsByTabId: layouts.source(
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`tab-${i}`, undefined]))
      ),
      paneForegroundAgentByPaneKey: foreground.source(
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            status(i).paneKey,
            { agent: 'claude' as const, shellForeground: false }
          ])
        )
      )
    })
    const select = selectors.selectLiveAgentStatusEntriesForWorktree
    const input = vi
      .spyOn(selectors, 'selectLiveAgentStatusEntriesForWorktree')
      .mockImplementation((...args) => {
        const result = select(...args)
        entries += result.length
        let proxy = arrays.get(result)
        if (!proxy) {
          proxy = new Proxy(result, {
            get(target, key) {
              if (fresh && typeof key === 'string' && /^\d+$/.test(key)) {
                freshnessVisits++
              }
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
              return target[key as keyof typeof target]
            }
          })
          arrays.set(result, proxy)
        }
        return proxy
      })
    const build = rows.buildWorktreeAgentRows
    const builds = vi.spyOn(rows, 'buildWorktreeAgentRows').mockImplementation((args) => {
      rowInputs += args.entries.length + args.retained.length
      return build(args)
    })
    const apply = lineage.applyAgentRowLineage
    vi.spyOn(lineage, 'applyAgentRowLineage').mockImplementation((...args) => {
      lineageInputs += args[0].length
      return apply(...args)
    })
    const compare = order.compareWorktreeAgentRows
    vi.spyOn(order, 'compareWorktreeAgentRows').mockImplementation((a, b) => {
      comparisons++
      return compare(a, b)
    })
    render(
      <>
        {Array.from({ length: n }, (_, id) => (
          <Probe key={id} id={id} sender={id % (n - 1)} />
        ))}
      </>
    )
    expect(builds).toHaveBeenCalledTimes(1)
    expect(handleEntries).toBe(n)
    expect(rowInputs).toBe(n)
    expect(lineageInputs).toBe(n)
    expect(entries).toBe(n * input.mock.calls.length)
    expect(comparisons).toBe(n - 1) // This corpus is ordered by distinct tab sortOrder.
    expect(freshnessVisits).toBe(n)
    expect(pointReads).toBeLessThanOrEqual(locate.mock.calls.length + n)
    expect(paneWrites).toBe(n) // Exactly the projected pane-view population.
    expect(projections).toHaveBeenCalledTimes(1)
    for (const metric of recordWork.values()) {
      expect(metric.calls).toBe(1)
      expect(metric.source).toBe(n) // Exactly one N-entry selector construction, independent of card count.
    }
    const counts = new Map(renders)
    const reset = () => {
      input.mockClear()
      builds.mockClear()
      projections.mockClear()
      locate.mockClear()
      entries = 0
      rowInputs = 0
      lineageInputs = 0
      freshnessVisits = 0
      pointReads = 0
      paneWrites = 0
      handleEntries = 0
      comparisons = 0
      for (const metric of recordWork.values()) {
        metric.source = 0
        metric.keys = 0
        metric.reads = 0
        metric.calls = 0
      }
    }
    // Each record generation actually reconstructs the full workspace; the unchanged authority
    // shallow-compares the N built entries and carries the old identity (status-inputs contract).
    const state = useAppStore.getState()
    const nextRecords = {
      runtimePaneTitlesByTabId: titles.source({ ...state.runtimePaneTitlesByTabId }),
      ptyIdsByTabId: ptys.source({ ...state.ptyIdsByTabId }),
      terminalLayoutsByTabId: layouts.source({ ...state.terminalLayoutsByTabId }),
      paneForegroundAgentByPaneKey: foreground.source({ ...state.paneForegroundAgentByPaneKey })
    }
    reset()
    act(() => useAppStore.setState(nextRecords))
    expect(projections).toHaveBeenCalledTimes(1)
    expect(builds).not.toHaveBeenCalled()
    expect(handleEntries).toBe(0)
    expect(freshnessVisits).toBe(0)
    for (const metric of recordWork.values()) {
      expect(metric.calls).toBe(1)
      expect(metric.source).toBe(n)
      expect(metric.keys).toBe(0)
      expect(metric.reads).toBe(0)
    }
    expect(paneWrites).toBe(0)
    expect(pointReads).toBeLessThanOrEqual(locate.mock.calls.length)
    expect(renders).toEqual(counts)
    reset()
    act(() => useAppStore.setState({ sidebarBody: 'agents' }))
    expect(projections).toHaveBeenCalledTimes(1)
    expect(builds).not.toHaveBeenCalled()
    for (const metric of recordWork.values()) {
      expect(metric.calls).toBe(1)
      expect(metric.source).toBe(0)
      expect(metric.keys).toBe(0)
      expect(metric.reads).toBe(0)
    }
    reset()
    act(() => useAppStore.setState({ settings: { ...useAppStore.getState().settings } }))
    expect(handleEntries).toBe(n) // Same status map, changed owner-input tuple: rebuild its shared index once.
    expect(builds).not.toHaveBeenCalled()
    expect(renders).toEqual(counts)
    reset()
    write(n - 1, { state: 'blocked' })
    expect(builds).toHaveBeenCalledTimes(1)
    expect(rowInputs).toBe(n)
    expect(lineageInputs).toBe(n)
    expect(handleEntries).toBe(n)
    expect(entries).toBe(n * input.mock.calls.length)
    expect(freshnessVisits).toBe(n)
    expect(comparisons).toBe(n - 1)
    expect(projections).toHaveBeenCalledTimes(1)
    for (const metric of recordWork.values()) {
      expect(metric.calls).toBe(1)
      expect(metric.keys).toBe(0)
      expect(metric.source).toBe(0)
    }
    expect(paneWrites).toBe(n)
    expect(pointReads).toBeLessThanOrEqual(locate.mock.calls.length + n)
    expect(renders).toEqual(counts)
    handleEntries = 0
    rowInputs = 0
    lineageInputs = 0
    builds.mockClear()
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: {},
        retainedAgentsByPaneKey: Object.fromEntries(
          Array.from({ length: n }, (_, i) => {
            const entry = { ...status(i), state: 'done' as const }
            return [
              entry.paneKey,
              {
                entry,
                tab: makeTab({ id: `tab-${i}`, worktreeId: 'workspace', sortOrder: i }),
                worktreeId: 'workspace',
                agentType: 'claude' as const,
                startedAt: 1
              }
            ]
          })
        )
      })
    )
    expect(builds).toHaveBeenCalledTimes(1)
    expect(handleEntries).toBe(n)
    expect(rowInputs).toBe(n)
    expect(lineageInputs).toBe(n)
  }
)

it('uses the child row own glyph even when its parent program needs permission', () => {
  write(0, {
    programStatus: { state: 'blocked', observedAt: 2_000_000 },
    subagents: [{ id: 'child', state: 'working', startedAt: 2_000_000, description: 'Child' }]
  })
  const state = useAppStore.getState()
  const projected = cache.selectWorktreeAgentRowsCached({
    state,
    worktreeId: 'workspace',
    now: 2_000_000,
    generation: '',
    orchestration: selectors.selectRuntimeAgentOrchestrationForWorktree(state, 'workspace')
  })
  const child = projected.find((row) => row.childRow)!
  expect(child).toBeDefined()
  const locate = () => ({ host: 'local', worktreeId: 'workspace', paneKey: child.paneKey })
  let value: AgentMessageSenderView | undefined
  function Child() {
    value = useAgentMessageSenderSource(locate)
    return null
  }
  render(<Child />)
  expect(value?.dot).toBe('working')
})

it('uses the navigation owner rule for the target-less ambiguous stamped twin, preserving explicit targets', () => {
  const workspace = `${TEST_REPO.id}::/w`
  const entry = status(0, workspace)
  useAppStore.setState({
    repos: [TEST_REPO],
    activeWorktreeId: 'different',
    activeWorkspaceExecutionHostId: 'local',
    detectedWorktreesByRepo: {},
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: workspace, repoId: TEST_REPO.id, hostId: 'local' }),
        makeWorktree({ id: workspace, repoId: TEST_REPO.id, hostId: 'runtime:e' })
      ]
    },
    tabsByWorktree: { [workspace]: [makeTab({ id: 'tab-0', worktreeId: workspace })] },
    agentStatusByPaneKey: { [entry.paneKey]: entry }
  })
  const state = useAppStore.getState()
  expect(owners.getKnownExecutionHostIdForWorktree(state, workspace)).toBe('local')
  expect(structuredOwner.resolveStructuredAgentSessionOwner(state, workspace)).toBeNull()
  expect(senderLocation.agentMessageSenderOwner(state, workspace)).toBeNull()
  const sender = {
    party: { address: 'term_0', terminalHandle: 'term_0', orcaSessionId: null },
    name: 'Snapshot'
  }
  const view = renderHook(() => useAgentMessageSenderView(sender, workspace))
  expect(view.result.current).toEqual({})
  view.unmount()
  // Explicit receiving host continues to resolve its sender; missing glyph never decides control eligibility.
  const explicit = renderHook(() => useAgentMessageSenderView(sender, workspace, { kind: 'local' }))
  expect(explicit.result.current.dot).toBe('working')
})

it.each([100, 1000])(
  'counts nonempty live/retained/migration/orchestration populations at %i entries',
  (n) => {
    const live = Object.fromEntries(
      Array.from({ length: n }, (_, i) => {
        const entry = status(i)
        return [entry.paneKey, entry]
      })
    )
    const retained = Object.fromEntries(
      Array.from({ length: n }, (_, i) => {
        const entry = { ...status(i), paneKey: `retained-${i}:${LEAF}`, state: 'done' as const }
        return [
          entry.paneKey,
          {
            entry,
            tab: makeTab({ id: `retained-${i}`, worktreeId: 'workspace' }),
            worktreeId: 'workspace',
            agentType: 'claude' as const,
            startedAt: 1
          }
        ]
      })
    )
    const migration = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `migration-${i}`,
        {
          ptyId: `migration-${i}`,
          worktreeId: 'workspace',
          tabId: `migration-${i}`,
          leafId: LEAF,
          paneKey: `migration-${i}:${LEAF}`,
          reason: 'legacy-numeric-pane-key' as const,
          source: 'local' as const,
          updatedAt: 1
        }
      ])
    )
    const orchestration = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        status(i).paneKey,
        { taskId: `task-${i}`, dispatchId: `dispatch-${i}`, orchestrationRunId: `run-${i}` }
      ])
    )
    const population = new Map<SenderPopulation, { calls: number; entries: number }>()
    for (const source of [live, retained, migration, orchestration]) {
      population.set(source, { calls: 0, entries: 0 })
    }
    const enumerated = (source: SenderPopulation, length: number) => {
      const metric = population.get(source)
      if (metric) {
        metric.calls++
        metric.entries += length
      }
    }
    const objectEntries = Object.entries,
      objectValues = Object.values
    vi.spyOn(Object, 'entries').mockImplementation((source: SenderPopulation) => {
      const result = objectEntries(source)
      enumerated(source, result.length)
      return result
    })
    vi.spyOn(Object, 'values').mockImplementation((source: SenderPopulation) => {
      const result = objectValues(source)
      enumerated(source, result.length)
      return result
    })
    const selectOrchestration = selectors.selectRuntimeAgentOrchestrationForWorktree
    const contexts = vi
      .spyOn(selectors, 'selectRuntimeAgentOrchestrationForWorktree')
      .mockImplementation((...args) => selectOrchestration(...args))
    const build = rows.buildWorktreeAgentRows
    const builds = vi
      .spyOn(rows, 'buildWorktreeAgentRows')
      .mockImplementation((args) => build(args))
    useAppStore.setState({
      agentStatusByPaneKey: live,
      retainedAgentsByPaneKey: retained,
      migrationUnsupportedByPtyId: migration,
      runtimeAgentOrchestrationByPaneKey: orchestration,
      tabsByWorktree: {
        workspace: Array.from({ length: n }, (_, i) => [
          makeTab({ id: `tab-${i}`, worktreeId: 'workspace' }),
          makeTab({ id: `retained-${i}`, worktreeId: 'workspace' }),
          makeTab({ id: `migration-${i}`, worktreeId: 'workspace' })
        ]).flat()
      }
    })
    render(
      <>
        {Array.from({ length: n }, (_, id) => (
          <Probe key={id} id={id} sender={id} />
        ))}
      </>
    )
    expect(contexts).toHaveBeenCalledTimes(1)
    expect(builds).toHaveBeenCalledTimes(1)
    const args = builds.mock.calls[0][0]
    expect(args.tabs).toHaveLength(n * 3)
    expect(args.entries).toHaveLength(n * 2)
    expect(args.retained).toHaveLength(n)
    expect(Object.keys(args.runtimeAgentOrchestrationByPaneKey!)).toHaveLength(n)
    // One live handle-index + one authority live-index enumeration; each other source once.
    expect(population.get(live)).toEqual({ calls: 2, entries: n * 2 })
    for (const source of [retained, migration, orchestration]) {
      expect(population.get(source)).toEqual({ calls: 1, entries: n })
    }
    for (const metric of population.values()) {
      metric.calls = 0
      metric.entries = 0
    }
    builds.mockClear()
    contexts.mockClear()
    act(() => useAppStore.setState({ sidebarBody: 'agents' }))
    expect(contexts).toHaveBeenCalledTimes(1)
    expect(builds).not.toHaveBeenCalled()
    for (const metric of population.values()) {
      expect(metric).toEqual({ calls: 0, entries: 0 })
    }
  }
)
