// @vitest-environment happy-dom
import { useState } from 'react'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { useStore } from 'zustand'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { useTaskPageLinearInOrcaEffects } from './use-task-page-linear-in-orca-effects'
import { useTaskPageLinearCollectionEffectsPrelude } from './use-task-page-linear-collection-effects'
import { useTaskPageLinearCustomViewEffects } from './use-task-page-linear-custom-view-effects'
import { useTaskPageDetailRouting } from '../use-task-page-detail-routing'
import { useLinearIssueWorkspaceDetail } from '../../linear-issue-workspace-detail-state'
import { useSmartWorkspaceSecondarySearches } from '../../new-workspace/use-smart-workspace-secondary-searches'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  renderHook,
  waitFor,
  render,
  fireEvent,
  screen
} from '@testing-library/react'
import { createTestStore, deferred, issue } from '../../../store/slices/linear-slice-test-harness'
import { clearLinearRequestMaps } from '../../../store/slices/linear/linear-slice-request-state'
import { useTaskPageLinearListSelectionPrelude } from './use-task-page-linear-list-selection'
import { LinearStateCell } from './task-page-linear-issue-model'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import { useTaskPageLinearListEffects } from './use-task-page-linear-list-effects'

const active = vi.hoisted(() => ({ store: vi.fn<() => Store>() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: ReturnType<Store['getState']>) => unknown) =>
      useStore(active.store(), selector),
    {
      getState: () => active.store().getState(),
      subscribe: (...args: Parameters<Store['subscribe']>) => active.store().subscribe(...args)
    }
  )
}))
vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  translate: (_key: string, fallback: string) => fallback
}))
const reads = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  project: vi.fn(),
  view: vi.fn(),
  detail: vi.fn(),
  update: vi.fn()
}))
vi.mock('@/runtime/runtime-linear-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearListIssues: (...args: unknown[]) => reads.list(...args),
  linearSearchIssues: (...args: unknown[]) => reads.search(...args)
}))
vi.mock('@/runtime/runtime-linear-project-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearListProjectIssues: (...args: unknown[]) => reads.project(...args),
  linearListCustomViewIssues: (...args: unknown[]) => reads.view(...args)
}))
vi.mock('@/runtime/runtime-linear-issue-mutations', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearGetIssue: reads.detail,
  linearIssueComments: async () => [],
  linearUpdateIssue: reads.update
}))
vi.mock('@/hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn(),
  useTeamStates: () => ({
    data: [{ id: 'done', name: 'Done', type: 'completed', color: '#888888' }],
    loading: false
  })
}))

function task(state = 'In Review') {
  return {
    ...issue('same-uuid'),
    identifier: 'DAT-124',
    workspaceId: 'w',
    state: { name: state, type: state === 'Done' ? 'completed' : 'started', color: '#888888' }
  }
}
function store() {
  const result = createTestStore()
  result.setState({ linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'w' } })
  active.store.mockReturnValue(result)
  return result
}
type Store = ReturnType<typeof store>
type View = 'list' | 'search' | 'project' | 'custom-view'
const views: View[] = ['list', 'search', 'project', 'custom-view']
const listArgs = { kind: 'list', filter: 'all', limit: 36 } as const
function read(s: Store, view: View, force = true) {
  const state = s.getState()
  if (view === 'search') {
    return state.searchLinearIssues('DAT-124', 36, { force })
  }
  if (view === 'project') {
    return state.listLinearProjectIssues('p', 'w', 36, { force })
  }
  if (view === 'custom-view') {
    return state.listLinearCustomViewIssues('v', 'w', 36, { force })
  }
  return state.listLinearIssues(listArgs, { force })
}
function wire(view: View) {
  return view === 'custom-view' ? reads.view : reads[view]
}
function response(view: View, state: string) {
  return view === 'search' ? [task(state)] : { items: [task(state)] }
}
function fixture(s: Store, rows: LinearIssue[], view: View = 'list') {
  const state = s.getState()
  return {
    settings: null,
    linearStatus: state.linearStatus,
    selectedLinearWorkspaceId: 'w',
    linearTaskSourceContext: null,
    linearMode: 'issues',
    linearAttributeFilter: { stateIds: [], priorities: [], assignee: null, labelIds: [] },
    linearAttributeFilterWorkspaceId: 'w',
    linearIssues: rows,
    linearIssueLimit: 36,
    linearIssuePage: 0,
    linearIssueLoadingTargetPage: null,
    linearIssuesHasMore: false,
    linearLoading: false,
    linearError: null,
    appliedLinearSearch: view === 'search' ? 'DAT-124' : '',
    selectedLinearProject:
      view === 'project' ? { id: 'p', workspaceId: 'w', name: 'Project' } : null,
    linearProjectTab: view === 'project' ? 'issues' : 'overview',
    linearProjectIssuesResult: { items: rows },
    linearProjectIssueLimit: 36,
    linearProjectIssuePage: 0,
    linearProjectIssueLoadingTargetPage: null,
    linearProjectIssuesLoading: false,
    linearProjectIssuesError: null,
    selectedLinearCustomView:
      view === 'custom-view' ? { id: 'v', workspaceId: 'w', model: 'issue', name: 'View' } : null,
    linearCustomViewIssuesResult: { items: rows },
    linearCustomViewIssueLimit: 36,
    linearCustomViewIssuePage: 0,
    linearCustomViewIssueLoadingTargetPage: null,
    linearCustomViewContentsLoading: false,
    linearCustomViewContentsError: null,
    availableTeams: []
  }
}
function display(s: Store, rows: LinearIssue[], view: View = 'list') {
  const base = { ...fixture(s, rows, view), ...s.getState() }
  const noop = vi.fn()
  return renderHook(() => {
    const [current, setRows] = useState(rows)
    const model = {
      ...base,
      linearIssues: current,
      linearProjectIssuesResult: { items: current },
      linearCustomViewIssuesResult: { items: current },
      taskResumeApplied: true,
      filteredLinearIssues: rows,
      clearSelectedLinearIssue: noop,
      linearConnected: true,
      taskSource: 'linear',
      linearRefreshNonce: 0,
      fetchLinearProject: async () => ({ id: 'p' }),
      setSelectedLinearProjectDetail: noop,
      setLinearProjectDetailLoading: noop,
      setLinearProjectDetailError: noop,
      setLinearProjectIssuesLoading: noop,
      setLinearProjectIssuesError: noop,
      setLinearCustomViewContentsLoading: noop,
      setLinearCustomViewContentsError: noop,
      setLinearCustomViewProjectsResult: noop,
      setLinearProjectIssuesResult: (update: React.SetStateAction<{ items: LinearIssue[] }>) =>
        setRows((items) => (typeof update === 'function' ? update({ items }) : update).items),
      setLinearCustomViewIssuesResult: (update: React.SetStateAction<{ items: LinearIssue[] }>) => {
        if (view === 'custom-view') {
          setRows((items) => (typeof update === 'function' ? update({ items }) : update).items)
        }
      }
    }
    // SAFETY: fixture supplies the selected collection loader's fields; unrelated persistence is disabled.
    useTaskPageLinearCollectionEffectsPrelude({
      ...model,
      selectedLinearProject: view === 'project' ? base.selectedLinearProject : null
    } as never)
    // SAFETY: fixture supplies the custom-view loader fields and no view inventory is requested.
    useTaskPageLinearCustomViewEffects({ ...model, linearMode: 'issues' } as never)
    // List/search cache notifications are exercised with the real loader in loadingHook.
    // SAFETY: fixture supplies the selection prelude fields.
    return useTaskPageLinearListSelectionPrelude(model as never)
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  clearLinearRequestMaps()
})
afterEach(() => {
  cleanup()
  clearLinearRequestMaps()
})

describe('Linear refresh row authority', () => {
  it.each(views)(
    '%s displays a successful refresh over expired detail and unrelated search copies',
    async (view) => {
      const s = store()
      s.setState({
        linearIssueCache: { 'w::DAT-124': { data: task(), fetchedAt: 1 } },
        linearSearchCache: { 'w::search::old-query::36': { data: [task()], fetchedAt: 1 } }
      })
      wire(view).mockResolvedValue(response(view, 'Done'))
      const result = await read(s, view)
      const rows = Array.isArray(result) ? result : result.items
      expect(rows[0].state.name).toBe('Done')
      expect(display(s, rows, view).result.current.displayedLinearIssues[0].state.name).toBe('Done')
    }
  )

  it.each(['project', 'custom-view'] as const)(
    '%s keeps optimistic edits and rollback visible through its active collection',
    async (view) => {
      const s = store()
      wire(view).mockResolvedValue(response(view, 'In Review'))
      const result = await read(s, view)
      const rows = Array.isArray(result) ? result : result.items
      const hook = display(s, rows, view)
      act(() => s.getState().patchLinearIssue('same-uuid', { state: task('Done').state }))
      expect(hook.result.current.displayedLinearIssues[0].state.name).toBe('Done')
      act(() => s.getState().patchLinearIssue('same-uuid', { state: task().state }))
      expect(hook.result.current.displayedLinearIssues[0].state.name).toBe('In Review')
    }
  )

  it.each(views)(
    '%s refresh starts after the click and an older forced response cannot overwrite it',
    async (view) => {
      const s = store()
      const old = deferred<ReturnType<typeof response>>()
      const fresh = deferred<ReturnType<typeof response>>()
      wire(view).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
      const beforeClick = read(s, view)
      const afterClick = read(s, view)
      const dispatches = wire(view).mock.calls.length
      // Resolve both even on the buggy implementation so a failing assertion leaves no pending request.
      old.resolve(response(view, 'In Review'))
      await beforeClick
      const joined = read(s, view, false)
      expect(wire(view)).toHaveBeenCalledTimes(2)
      fresh.resolve(response(view, 'Done'))
      const [, refreshed] = await Promise.all([beforeClick, afterClick, joined])
      expect(dispatches).toBe(2)
      const rows = Array.isArray(refreshed) ? refreshed : refreshed.items
      expect(rows[0].state.name).toBe('Done')
      const caches =
        view === 'list'
          ? s.getState().linearListCache
          : view === 'search'
            ? s.getState().linearSearchCache
            : view === 'project'
              ? s.getState().linearProjectIssueCache
              : s.getState().linearCustomViewIssueCache
      const cached = Object.values(caches)[0].data
      expect(Array.isArray(cached) ? cached[0].state.name : cached?.items[0].state.name).toBe(
        'Done'
      )
    }
  )
})

function loadingHook(s: Store, query = '', extra = {}) {
  const refs = {
    linearSearchPersistReadyRef: { current: false },
    linearViewPersistReadyRef: { current: false },
    linearAttributeFilterReadRef: { current: null },
    lastLinearRequestRef: { current: null },
    landingLinearRefreshKeysRef: { current: new Set<string>() }
  }
  const noop = vi.fn()
  const base = {
    ...fixture(s, [task()]),
    ...refs,
    ...s.getState(),
    taskSource: 'linear',
    linearConnected: true,
    taskResumeApplied: true,
    linearSearchInput: query,
    appliedLinearSearch: query,
    setTaskResumeState: noop,
    setAppliedLinearSearch: noop,
    setLinearIssueLimit: noop,
    setLinearIssuePage: noop,
    setLinearIssueLoadingTargetPage: noop,
    setLinearIssuesHasMore: noop,
    setLinearLoading: noop,
    linearIssueFiltersByWorkspaceId: {},
    ...extra
  }
  return renderHook(
    ({ nonce }) => {
      const [rows, setLinearIssues] = useState([task()])
      const [error, setLinearError] = useState<string | null>(null)
      // SAFETY: fixture supplies the loader's dependencies; persistence setters are inert in this hook test.
      useTaskPageLinearListEffects({
        ...base,
        linearRefreshNonce: nonce,
        setLinearIssues,
        setLinearError
      } as never)
      return { rows, error }
    },
    { initialProps: { nonce: 0 } }
  )
}

describe('Linear refresh failure', () => {
  it.each(['list', 'search'] as const)(
    '%s shows failure while retaining rows, then clears it on successful retry',
    async (kind) => {
      const s = store()
      const query = kind === 'search' ? 'DAT-124' : ''
      const runtime = kind === 'search' ? reads.search : reads.list
      runtime.mockResolvedValue(response(kind, 'In Review'))
      await read(s, kind)
      runtime.mockRejectedValueOnce(new Error('raw provider private diagnostic'))
      const hook = loadingHook(s, query)
      await waitFor(() =>
        expect(hook.result.current.error).toBe('Unable to load Linear issues. Try again.')
      )
      expect(hook.result.current.rows[0].state.name).toBe('In Review')
      runtime.mockResolvedValue(response(kind, 'Done'))
      hook.rerender({ nonce: 1 })
      await waitFor(() => expect(hook.result.current.rows[0].state.name).toBe('Done'))
      expect(hook.result.current.error).toBeNull()
    }
  )

  it('retains rows and surfaces workspace errors returned by the plain list', async () => {
    const s = store()
    reads.list.mockResolvedValueOnce({ items: [task()] })
    await read(s, 'list')
    reads.list.mockResolvedValue({
      items: [],
      errors: [
        {
          workspaceId: 'w',
          workspaceName: 'Workspace',
          type: 'network',
          message: 'Linear is unavailable. Try refreshing again.'
        }
      ]
    })
    const hook = loadingHook(s)
    await waitFor(() => expect(hook.result.current.error).toBeTruthy())
    expect(hook.result.current.rows[0].state.name).toBe('In Review')
  })
})

function source(hostId: TaskSourceContext['hostId']): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'linear',
    hostId,
    projectId: 'project',
    repoId: null,
    providerIdentity: null,
    accountLabel: null
  }
}

it('keeps a filtered status-cell success through invalidation and rolls back a later failed edit', async () => {
  const s = store()
  s.setState({ recordFeatureInteraction: vi.fn() })
  reads.list.mockResolvedValue({ items: [task()] })
  const filter = { stateIds: ['review'], priorities: [], assignee: null, labelIds: [] }
  const hook = loadingHook(s, '', { linearAttributeFilter: filter })
  await waitFor(() => expect(reads.list).toHaveBeenCalled())
  const pending = deferred<{ ok: boolean }>()
  reads.update.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ok: false })
  const cell = render(<LinearStateCell issue={task()} />)
  fireEvent.click(screen.getByRole('button', { name: /Change Linear state from/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Done', exact: true }))
  await waitFor(() => expect(hook.result.current.rows[0].state.name).toBe('Done'))
  await act(async () => {
    pending.resolve({ ok: true })
    await pending.promise
  })
  expect(s.getState().getCachedLinearIssues({ ...listArgs, attributeFilter: filter })).toBeNull()
  expect(hook.result.current.rows[0].state.name).toBe('Done')
  // A separate failed edit starts from the last provider-confirmed row.
  cell.unmount()
  reads.list.mockResolvedValue({ items: [task()] })
  await act(async () => {
    await s.getState().listLinearIssues({ ...listArgs, attributeFilter: filter }, { force: true })
  })
  render(<LinearStateCell issue={task()} />)
  fireEvent.click(screen.getByRole('button', { name: /Change Linear state from/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Done', exact: true }))
  await waitFor(() => expect(hook.result.current.rows[0].state.name).toBe('In Review'))
  expect(reads.update).toHaveBeenCalledTimes(2)
})

it('retains ordered linked source provenance when two hosts return the same UUID', async () => {
  const s = store()
  const first = source('local'),
    second = source('runtime:other')
  const refs = [
    { identifier: 'DAT-124', workspaceId: 'w', sourceContext: first },
    { identifier: 'DAT-124', workspaceId: 'w', sourceContext: second }
  ]
  // Real detail actions create the requested source/identifier keys.
  reads.detail.mockResolvedValueOnce(task()).mockResolvedValueOnce(task('Done'))
  const base = {
    ...fixture(s, []),
    ...s.getState(),
    taskResumeApplied: true,
    taskSource: 'linear',
    linearMode: 'in-orca',
    linearConnected: true,
    linearRefreshNonce: 0,
    lastLinearRequestRef: { current: null },
    inOrcaLinkedLinearRefsRef: { current: refs },
    inOrcaLinkedLinearRefsSignature: 'two-hosts',
    setLinearLoading: vi.fn(),
    setLinearError: vi.fn(),
    setLinearIssuesHasMore: vi.fn()
  }
  const hook = renderHook(() => {
    const [rows, setLinearIssues] = useState<LinearIssue[]>([])
    // SAFETY: fixture supplies the linked loader fields.
    useTaskPageLinearInOrcaEffects({ ...base, setLinearIssues } as never)
    return rows
  })
  await waitFor(() => expect(hook.result.current).toHaveLength(2))
  act(() =>
    s
      .getState()
      .patchLinearIssue('same-uuid', { state: task('Blocked').state }, { sourceContext: first })
  )
  expect(hook.result.current.map((item) => item.state.name)).toEqual(['Blocked', 'Done'])
  act(() =>
    s.getState().patchLinearIssue('same-uuid', { state: task().state }, { sourceContext: first })
  )
  expect(hook.result.current.map((item) => item.state.name)).toEqual(['In Review', 'Done'])
})

it('opens the fresh row on its origin source despite stale aliases and failed detail hydration', async () => {
  const s = store(),
    origin = source('runtime:origin'),
    foreign = source('local')
  s.setState({
    jiraIssueCache: {},
    jiraSearchCache: {},
    linearIssueCache: {
      [`${getTaskSourceCacheScope(origin)}::w::DAT-124`]: { data: task(), fetchedAt: 1 },
      [`${getTaskSourceCacheScope(foreign)}::w::same-uuid`]: { data: task(), fetchedAt: Date.now() }
    }
  })
  reads.detail.mockRejectedValue(new Error('raw detail failure'))
  const hook = renderHook(() => {
    // SAFETY: routing fixture only opens Linear; Jira and callbacks are inert.
    const route = useTaskPageDetailRouting({
      pageData: { openLinearIssue: task('Done'), openLinearSourceContext: origin },
      linearTaskSourceContext: foreign,
      setDialogWorkItem: vi.fn(),
      openTaskPage: vi.fn()
    } as never)
    const detail = useLinearIssueWorkspaceDetail({
      issue: route.selectedLinearIssue ?? task(),
      providerSettings: route.linearDetailSourceContext,
      requestKey: 'origin:uuid'
    })
    return { route, detail }
  })
  await waitFor(() => expect(hook.result.current.detail.issueLoading).toBe(false))
  expect(hook.result.current.detail.displayed.state.name).toBe('Done')
  expect(reads.detail).toHaveBeenCalledWith(origin, 'same-uuid', 'w')
})

it('preserves New Workspace same-query warm rows on rejection and reports cold failure', async () => {
  const s = store()
  reads.search.mockResolvedValue([task()])
  await s.getState().searchLinearIssues('DAT-124', 12)
  const setter = vi.fn(),
    error = vi.fn()
  const base = {
    ...s.getState(),
    disabled: false,
    jiraSource: { intent: false },
    selectedRepo: null,
    branchesEnabled: false,
    linearSourceContext: null,
    linearWorkspaceIdOverride: 'w',
    setBranches: vi.fn(),
    setBranchResultsSource: vi.fn(),
    setBranchesLoading: vi.fn(),
    setLinearIssues: setter,
    setLinearReadError: error,
    setLinearLoading: vi.fn(),
    setSettledLinearUrlQuery: vi.fn(),
    setJiraIssues: vi.fn(),
    setJiraLoading: vi.fn(),
    searchLinearIssues: vi.fn().mockRejectedValue(new Error('raw failure'))
  }
  const hook = renderHook(
    ({ query }) => {
      // SAFETY: fixture disables repo/Jira reads and supplies Linear setters.
      useSmartWorkspaceSecondarySearches({
        foundation: base,
        shouldQueryLinear: true,
        linearQuery: query,
        linearUrlIntent: null,
        linearUrlIntentOwnsInput: false,
        shouldQueryJira: false,
        jiraSearchQuery: null
      } as never)
    },
    { initialProps: { query: 'DAT-124' } }
  )
  await waitFor(() =>
    expect(error).toHaveBeenLastCalledWith('Unable to load Linear issues. Try again.')
  )
  expect(setter).toHaveBeenLastCalledWith([task()])
  hook.rerender({ query: 'missing' })
  await waitFor(() => expect(setter).toHaveBeenLastCalledWith([]))
  expect(error).toHaveBeenLastCalledWith('Unable to load Linear issues. Try again.')
})

it('keeps failed-workspace rows beside fresh partial list results and reports one sanitized error', async () => {
  const s = store()
  reads.list.mockResolvedValueOnce({ items: [task()] })
  await read(s, 'list')
  reads.list.mockResolvedValue({
    items: [{ ...task('Done'), id: 'another', workspaceId: 'healthy' }],
    errors: [{ workspaceId: 'w', type: 'network', message: 'secret provider diagnostic' }]
  })
  const hook = loadingHook(s)
  await waitFor(() => expect(hook.result.current.rows).toHaveLength(2))
  expect(hook.result.current.rows.map((row) => row.state.name)).toEqual(['Done', 'In Review'])
  expect(hook.result.current.error).toBe('Unable to load Linear issues. Try again.')
})

it.each(['project', 'custom-view'] as const)(
  '%s failure uses only its source-qualified smaller collection and retains the request error',
  async (view) => {
    const s = store(),
      origin = source('runtime:origin')
    const load = (limit: number, sourceContext: TaskSourceContext | null) =>
      view === 'project'
        ? s.getState().listLinearProjectIssues('p', 'w', limit, { force: true, sourceContext })
        : s.getState().listLinearCustomViewIssues('v', 'w', limit, { force: true, sourceContext })
    wire(view)
      .mockResolvedValueOnce({ items: [task('Foreign')] })
      .mockResolvedValueOnce({ items: [task()] })
    await load(12, null)
    await load(12, origin)
    wire(view).mockRejectedValueOnce(new Error('raw network details'))
    const result = await load(36, origin)
    expect(result.items[0].state.name).toBe('In Review')
    // The fallback error is not cached; selection must retain this request's error beside cached rows.
    const model = {
      ...fixture(s, result.items, view),
      linearProjectIssuesResult: result,
      linearCustomViewIssuesResult: result
    }
    // SAFETY: the fixture supplies the selection prelude fields.
    const hook = renderHook(() => useTaskPageLinearListSelectionPrelude(model as never))
    expect(hook.result.current.activeLinearIssueError).toBe(
      'Unable to load Linear issues. Try again.'
    )
  }
)
