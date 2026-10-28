import { useStore } from 'zustand'
import { createTestStore } from '@/store/slices/linear-slice-test-harness'
import { clearLinearRequestMaps } from '@/store/slices/linear/linear-slice-request-state'
import {
  buildTaskSourceContextFromRepo,
  getTaskSourceCacheScope
} from '../../../../shared/task-source-context'
import { linearSearchCacheKey } from '@/store/slices/linear/linear-cache'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'
// @vitest-environment happy-dom

import React from 'react'
import type * as ReactModule from 'react'
import { act } from '@testing-library/react'
import { registerRuntimeClientIpcBridge } from '@/hooks/ipc-events/runtime-client-ipc-bridge'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearConnectionStatus } from '../../../../shared/linear/workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import { WorkspaceAttachmentSourceStatus } from '../sidebar/WorkspaceAttachmentSourceStatus'
import { Command } from '@/components/ui/command'
import {
  referenceLinearIssue,
  referenceRepo
} from '../sidebar/workspace-reference-fixtures.test-support'
import { SmartWorkspaceSourceResultList } from './SmartWorkspaceSourceResultList'
import { useWorkItemSourceSearch } from './use-work-item-source-search'

const queued = vi.hoisted(() => ({ enabled: false, updates: [] as VoidFunction[] }))
vi.mock('react', async (original) => {
  const actual = await original<typeof ReactModule>()
  return {
    ...actual,
    useState<T>(initial: T | (() => T)) {
      const [value, setValue] = actual.useState(initial)
      const array = actual.useRef(Array.isArray(value))
      const set = actual.useCallback((update: React.SetStateAction<T>) => {
        if (queued.enabled && array.current && typeof update === 'function') {
          queued.updates.push(() => setValue(update))
        } else {
          setValue(update)
        }
      }, [])
      return [value, set] as const
    }
  }
})
const events = vi.hoisted(() => ({ emit: (_event: RuntimeClientEvent) => {} }))
vi.mock('@/runtime/runtime-client-events', () => ({
  subscribeRuntimeClientEvents: async (
    _id: string,
    onEvent: (event: RuntimeClientEvent) => void
  ) => {
    events.emit = onEvent
    return { unsubscribe: () => {} }
  }
}))
const mocks = vi.hoisted(() => {
  // Host-wide status carries no error: the composer must show the read's own failure.
  const linearStatus: LinearConnectionStatus = {
    connected: true,
    viewer: null,
    selectedWorkspaceId: 'workspace-1'
  }
  return {
    state: {
      checkLinearConnection: vi.fn(),
      getCachedLinearIssues: vi.fn(),
      linearStatus,
      // The repo's own host: its status refresh reaches the composer's host-scoped read.
      linearStatusContextKey: 'runtime:env-1#0',
      linearStatusChecked: true,
      settings: null,
      preflightStatus: null,
      preflightStatusChecked: true,
      preflightStatusContextKey: 'test',
      refreshPreflightStatus: vi.fn(),
      searchLinearIssues: vi.fn(),
      list: vi.fn(),
      detail: vi.fn()
    }
  }
})
let stopBridge = () => {}
let restoreApi = () => {}
let pickerStore: ReturnType<typeof createTestStore>
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: Parameters<typeof pickerStore>[0]) => useStore(pickerStore, selector),
    {
      getState: () => pickerStore.getState(),
      subscribe: (...args: Parameters<typeof pickerStore.subscribe>) =>
        pickerStore.subscribe(...args)
    }
  )
}))
vi.mock('@/runtime/runtime-linear-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearStatus: async () => mocks.state.linearStatus,
  linearListIssues: (...args: unknown[]) => mocks.state.list(...args),
  linearSearchIssues: (_settings: unknown, query: string) => mocks.state.searchLinearIssues(query)
}))
vi.mock('@/runtime/runtime-linear-issue-mutations', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearGetIssue: (...args: unknown[]) => mocks.state.detail(...args)
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({}),
  localPreflightContextKey: () => 'test'
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./use-jira-source-connection', () => ({
  useJiraSourceConnection: () => ({ status: null, loaded: false })
}))
vi.mock('./use-jira-url-source', () => ({ useJiraUrlSource: () => ({ intent: false }) }))
vi.mock('../use-jira-project-inventory', () => ({
  useJiraProjectInventory: () => ({ projects: [], connected: true, error: null, loading: false })
}))

const repo: Repo = { ...referenceRepo, executionHostId: 'runtime:env-1' }
// Stable identity: search effects depend on the repos array.
const repos = [repo]
const onSelect = vi.fn()
const ignoreRetry = () => {}

function LinearPicker({
  value,
  attachment = false,
  defaultSource = false,
  onRetry = ignoreRetry
}: {
  value: string
  attachment?: boolean
  defaultSource?: boolean
  onRetry?: () => void
}): React.JSX.Element {
  const controller = useWorkItemSourceSearch({
    repos,
    selectedRepo: defaultSource ? null : repo,
    repoId: defaultSource ? null : repo.id,
    value,
    branchesEnabled: false,
    repoBackedSourcesDisabled: true
  })
  return (
    <Command>
      <button type="button" onClick={() => controller.setMode('linear')}>
        Linear tab
      </button>
      <button type="button" onClick={() => controller.setMode('smart')}>
        Smart tab
      </button>
      <SmartWorkspaceSourceResultList model={controller} onSelect={onSelect} />
      {attachment ? (
        <WorkspaceAttachmentSourceStatus
          controller={controller}
          taskUrlProvider="linear"
          resolved={false}
          error={null}
          onRetry={onRetry}
        />
      ) : null}
    </Command>
  )
}

describe('composer Linear read errors', () => {
  beforeEach(() => {
    mocks.state.linearStatus = {
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'workspace-1'
    }
    clearLinearRequestMaps()
    pickerStore = createTestStore()
    const { searchLinearIssues: _search, getCachedLinearIssues: _cache, ...initial } = mocks.state
    pickerStore.setState(initial)
    onSelect.mockClear()
    mocks.state.searchLinearIssues.mockReset()
    mocks.state.getCachedLinearIssues.mockReset()
    mocks.state.getCachedLinearIssues.mockReturnValue(null)
  })
  afterEach(() => {
    cleanup()
    clearLinearRequestMaps()
  })

  it.each([
    { cache: 'cold', attachment: false },
    { cache: 'warm', attachment: false },
    { cache: 'cold', attachment: true },
    { cache: 'warm', attachment: true }
  ])(
    '$cache network failure is safe with attachment=$attachment and successful retry clears it',
    async ({ cache, attachment }) => {
      if (cache === 'warm') {
        const context = buildTaskSourceContextFromRepo({
          provider: 'linear',
          projectId: repo.id,
          repo
        })!
        const key = `${getTaskSourceCacheScope(context)}::${linearSearchCacheKey('workspace-1', 'launch', RESULT_LIMIT)}`
        pickerStore.setState({
          linearSearchCache: { [key]: { data: [referenceLinearIssue()], fetchedAt: 1 } }
        })
      }
      mocks.state.searchLinearIssues.mockRejectedValue(new Error('private network diagnostic'))
      const { rerender } = render(<LinearPicker value="launch" attachment={attachment} />)
      fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
      const message = 'Unable to load Linear issues. Try again.'
      await waitFor(() => expect(screen.getAllByText(message)).toHaveLength(1))
      expect(screen.queryByText('Reconnect Linear')).toBeNull()
      if (cache === 'warm') {
        fireEvent.click(screen.getByText(/Task/))
        expect(onSelect).toHaveBeenCalledTimes(1)
      }
      fireEvent.click(screen.getByRole('button', { name: 'Smart tab' }))
      expect(screen.queryByText(message)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
      mocks.state.searchLinearIssues.mockResolvedValue([referenceLinearIssue()])
      rerender(<LinearPicker value="recovered" attachment={attachment} />)
      await waitFor(() => expect(screen.getByText(/Task/)).toBeTruthy())
      await waitFor(() => expect(screen.queryByText(message)).toBeNull())
    }
  )

  it('shows the read credential error on the Linear tab only, and a successful search clears it', async () => {
    mocks.state.searchLinearIssues.mockImplementation(async (query) => {
      if (query === 'broken') {
        throw new Error(credentialDecryptionMessage('Linear'))
      }
      return [referenceLinearIssue()]
    })
    const message = 'Reconnect Linear'
    const { rerender } = render(<LinearPicker value="broken" />)
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        `${message}Unable to read saved Linear login. Reconnect it in Settings.`
      )
    )

    // The status refresh after the failure re-runs the same read; the error must stay up.
    mocks.state.linearStatus = {
      ...mocks.state.linearStatus,
      credentialError: credentialDecryptionMessage('Linear')
    }
    rerender(<LinearPicker value="broken" />)
    expect(screen.getByText(message)).toBeTruthy()
    await waitFor(() => expect(mocks.state.searchLinearIssues).toHaveBeenCalled())
    expect(screen.getByText(message)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Smart tab' }))
    expect(screen.queryByText(message)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))

    rerender(<LinearPicker value="launch" />)
    await waitFor(() => expect(screen.getByText(/Task/)).toBeTruthy())
    expect(screen.queryByText(message)).toBeNull()
  })
})

it.each(
  ['list', 'search'].flatMap((kind) =>
    ['success', 'error', 'queued'].map((outcome) => ({ kind, outcome }))
  )
)(
  'runtime refresh retires default New Workspace $kind pre-event $outcome',
  async ({ kind, outcome }) => {
    clearLinearRequestMaps()
    pickerStore = createTestStore()
    pickerStore.setState({
      // SAFETY: these consumers only inspect the active default host setting.
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearStatusChecked: true,
      preflightStatusChecked: true,
      preflightStatusContextKey: 'test',
      refreshPreflightStatus: vi.fn(),
      fetchHostWorkspaceStatuses: vi.fn(async () => {}),
      fetchRuntimeEnvironmentRepos: vi.fn(async () => []),
      fetchProjectGroups: vi.fn(async () => []),
      fetchFolderWorkspaces: vi.fn(async () => []),
      fetchWorktreeLineage: vi.fn(async () => {}),
      runtimeStatusByEnvironmentId: new Map(),
      runtimeEnvironments: [],
      sshStateByEnvironment: {}
    })
    cleanup()
    queued.enabled = false
    queued.updates.length = 0
    const old = Promise.withResolvers<LinearIssue[] | { items: LinearIssue[] }>()
    const fresh = Promise.withResolvers<LinearIssue[] | { items: LinearIssue[] }>()
    const runtime = kind === 'search' ? mocks.state.searchLinearIssues : mocks.state.list
    const data = (title: string) => {
      const items = [{ ...referenceLinearIssue(), title }]
      return kind === 'search' ? items : { items }
    }
    runtime.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const control = Promise.withResolvers<LinearIssue | null>()
    mocks.state.detail.mockReset()
    mocks.state.detail.mockImplementation((context) =>
      context.kind === 'task-source' || context.environmentId === 'other'
        ? control.promise
        : Promise.resolve(referenceLinearIssue())
    )
    const explicit = buildTaskSourceContextFromRepo({
      provider: 'linear',
      projectId: repo.id,
      repo
    })!
    const controls = [
      getLinearSourceScope(explicit),
      getLinearSourceScope({ ...explicit, accountLabel: 'Other full source' }),
      getLinearSourceScope({ kind: 'environment', environmentId: 'other' })
    ].map((scope) =>
      pickerStore.getState().fetchLinearIssue('ISSUE-1', 'workspace-1', { scope }).acquire()
    )
    expect(mocks.state.detail).toHaveBeenCalledTimes(3)
    const previousApi = window.api
    restoreApi = () => Object.assign(window, { api: previousApi })
    Object.assign(window, { api: { runtimeEnvironments: {} } })
    const unsubs: VoidFunction[] = []
    const stopStore = registerRuntimeClientIpcBridge(unsubs, {
      worktreeChangeRefreshQueue: { enqueue: vi.fn(), dispose: vi.fn() },
      activateNotifiedWorktree: vi.fn(async () => {})
    })
    stopBridge = () => {
      stopStore()
      unsubs.forEach((stop) => stop())
    }
    const mounted = render(<LinearPicker value={kind === 'search' ? 'launch' : ''} defaultSource />)
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
    await waitFor(() => expect(runtime).toHaveBeenCalledTimes(1))
    const joined = Array.from({ length: 5 }, () =>
      kind === 'search'
        ? pickerStore.getState().searchLinearIssues('launch', RESULT_LIMIT).acquire()
        : pickerStore
            .getState()
            .listLinearIssues({ kind: 'list', filter: 'assigned', limit: RESULT_LIMIT })
            .acquire()
    )
    expect(runtime).toHaveBeenCalledTimes(1)
    queued.enabled = true
    if (outcome === 'queued') {
      await act(async () => {
        old.resolve(data('Pre-event'))
        await old.promise
      })
    }
    const beforeEdge = queued.updates.splice(0)
    act(() =>
      events.emit({
        type: 'linearLinkedIssueUpdated',
        identifier: 'ISSUE-1',
        workspaceId: 'workspace-1'
      })
    )
    const replacementUpdates = queued.updates.splice(0)
    queued.enabled = false
    expect(runtime).toHaveBeenCalledTimes(2)
    expect(mocks.state.detail).toHaveBeenCalledTimes(4)
    act(() => beforeEdge.forEach((update) => update()))
    expect(screen.queryByText('Pre-event')).toBeNull()
    act(() => replacementUpdates.forEach((update) => update()))
    if (outcome !== 'queued') {
      await act(async () => {
        if (outcome === 'success') {
          old.resolve(data('Pre-event'))
        } else {
          old.reject(new Error('old private diagnostic'))
        }
        await old.promise.catch(() => {})
      })
      expect(screen.queryByText('Pre-event')).toBeNull()
    }
    await act(async () => {
      fresh.reject(new Error('private diagnostic'))
      await fresh.promise.catch(() => {})
    })
    await waitFor(() =>
      expect(screen.getAllByText('Unable to load Linear issues. Try again.')).toHaveLength(1)
    )
    expect(runtime).toHaveBeenCalledTimes(2)
    const forced = Promise.withResolvers<LinearIssue[] | { items: LinearIssue[] }>()
    const external = Promise.withResolvers<LinearIssue[] | { items: LinearIssue[] }>()
    runtime.mockReturnValueOnce(forced.promise).mockReturnValueOnce(external.promise)
    const force = () =>
      kind === 'search'
        ? pickerStore
            .getState()
            .searchLinearIssues('launch', RESULT_LIMIT, { force: true })
            .acquire()
        : pickerStore
            .getState()
            .listLinearIssues(
              { kind: 'list', filter: 'assigned', limit: RESULT_LIMIT },
              { force: true }
            )
            .acquire()
    let A!: ReturnType<typeof force>, B!: ReturnType<typeof force>
    act(() => {
      A = force()
      B = force()
    })
    expect(runtime).toHaveBeenCalledTimes(4)
    await act(async () => {
      forced.resolve(data('Superseded force'))
      external.resolve(data('External'))
      await external.promise
    })
    await waitFor(() => expect(screen.getByText(/External/)).toBeTruthy())
    expect(screen.queryByText(/Superseded force/)).toBeNull()
    expect(screen.queryByText('Unable to load Linear issues. Try again.')).toBeNull()
    A.release()
    B.release()
    control.resolve(referenceLinearIssue())
    await Promise.all(controls.map((lease) => lease.waitForCurrentTerminal()))
    expect(controls.every((lease) => lease.currentView().kind === 'data')).toBe(true)
    controls.forEach((lease) => lease.release())
    mounted.unmount()
    joined.forEach((lease) => lease.release())
    act(() =>
      events.emit({
        type: 'linearLinkedIssueUpdated',
        identifier: 'ISSUE-1',
        workspaceId: 'workspace-1'
      })
    )
    expect(runtime).toHaveBeenCalledTimes(4)
    stopBridge()
    stopBridge = () => {}
    cleanup()
    clearLinearRequestMaps()
  }
)

afterEach(() => {
  stopBridge()
  stopBridge = () => {}
  restoreApi()
  restoreApi = () => {}
  queued.enabled = false
  queued.updates.length = 0
  cleanup()
  clearLinearRequestMaps()
})

it('attachment Retry reacquires terminal cached missing without another provider read', async () => {
  pickerStore = createTestStore()
  const status: LinearConnectionStatus = {
    connected: true,
    viewer: null,
    selectedWorkspaceId: 'L',
    workspaces: [
      { id: 'L', organizationId: 'org', organizationName: 'Acme', organizationUrlKey: 'acme' }
    ]
  }
  mocks.state.linearStatus = status
  pickerStore.setState({
    linearStatus: status,
    linearStatusChecked: true,
    linearStatusContextKey: 'local#0',
    preflightStatusChecked: true,
    preflightStatusContextKey: 'test',
    refreshPreflightStatus: vi.fn()
  })
  mocks.state.detail.mockReset().mockResolvedValue(null)
  function Attachment() {
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0)
    return (
      <LinearPicker
        key={attempt}
        value="https://linear.app/acme/issue/ENG-1/missing"
        defaultSource
        attachment
        onRetry={retry}
      />
    )
  }
  render(<Attachment />)
  const missing = 'Couldn’t load this Linear issue. Check the URL and connected workspace.'
  await waitFor(() => expect(screen.getByText(missing)).toBeTruthy())
  expect(mocks.state.detail).toHaveBeenCalledTimes(1)
  expect(pickerStore.getState().linearIssueCache['L::ENG-1']?.data).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }))
  await waitFor(() => expect(screen.getByText(missing)).toBeTruthy())
  expect(screen.queryByText('Loading Linear issue…')).toBeNull()
  expect(mocks.state.detail).toHaveBeenCalledTimes(1)
})

it.each(['success', 'error', 'queued'])(
  'runtime event retires a held same-literal URL alias observation: %s',
  async (outcome) => {
    pickerStore = createTestStore()
    const status: LinearConnectionStatus = {
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'L',
      workspaces: [
        { id: 'L', organizationId: 'org', organizationName: 'Acme', organizationUrlKey: 'acme' },
        { id: 'W', organizationId: 'org', organizationName: 'Acme', organizationUrlKey: 'acme' },
        {
          id: 'F',
          organizationId: 'foreign',
          organizationName: 'Foreign',
          organizationUrlKey: 'foreign'
        }
      ]
    }
    const row = (title: string, workspaceId = 'L'): LinearIssue => ({
      ...referenceLinearIssue(),
      id: 'U',
      identifier: 'ENG-1',
      workspaceId,
      title,
      url: 'https://linear.app/acme/issue/ENG-1/task'
    })
    const old = Promise.withResolvers<LinearIssue | null>()
    const fresh = Promise.withResolvers<LinearIssue | null>()
    const control = Promise.withResolvers<LinearIssue | null>()
    let aliasLoads = 0
    mocks.state.detail.mockReset().mockImplementation((context, _id, workspaceId) => {
      if (
        context.kind === 'task-source' ||
        context.environmentId === 'other' ||
        workspaceId === 'F'
      ) {
        return control.promise
      }
      if (workspaceId === 'L') {
        return ++aliasLoads === 1 ? old.promise : fresh.promise
      }
      return Promise.resolve(row('Exact W', 'W'))
    })
    mocks.state.linearStatus = status
    pickerStore.setState({
      // SAFETY: event bridge only needs the active host and the listed refresh methods.
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      linearStatus: status,
      linearStatusChecked: true,
      linearStatusContextKey: 'runtime:env-1#0',
      preflightStatusChecked: true,
      preflightStatusContextKey: 'test',
      refreshPreflightStatus: vi.fn(),
      linearIssueCache: { 'L::ENG-1': { data: row('Warm'), fetchedAt: 1 } },
      fetchHostWorkspaceStatuses: vi.fn(async () => {}),
      fetchRuntimeEnvironmentRepos: vi.fn(async () => []),
      fetchProjectGroups: vi.fn(async () => []),
      fetchFolderWorkspaces: vi.fn(async () => []),
      fetchWorktreeLineage: vi.fn(async () => {}),
      runtimeStatusByEnvironmentId: new Map(),
      runtimeEnvironments: [],
      sshStateByEnvironment: {}
    })
    const explicit = buildTaskSourceContextFromRepo({
      provider: 'linear',
      projectId: repo.id,
      repo
    })!
    const controls = [
      pickerStore
        .getState()
        .fetchLinearIssue('ENG-1', 'F', { seed: { ...row('Foreign', 'F'), id: 'other-U' } })
        .acquire(),
      pickerStore
        .getState()
        .fetchLinearIssue('ENG-1', 'L', {
          scope: getLinearSourceScope(explicit),
          seed: row('Explicit')
        })
        .acquire(),
      pickerStore
        .getState()
        .fetchLinearIssue('ENG-1', 'L', {
          scope: getLinearSourceScope({ kind: 'environment', environmentId: 'other' }),
          seed: row('Other runtime')
        })
        .acquire()
    ]
    const controlViews = controls.map((lease) => lease.currentView())
    const previousApi = window.api
    restoreApi = () => Object.assign(window, { api: previousApi })
    Object.assign(window, { api: { runtimeEnvironments: {} } })
    const unsubs: VoidFunction[] = []
    const stop = registerRuntimeClientIpcBridge(unsubs, {
      worktreeChangeRefreshQueue: { enqueue: vi.fn(), dispose: vi.fn() },
      activateNotifiedWorktree: vi.fn(async () => {})
    })
    stopBridge = () => {
      stop()
      unsubs.forEach((unsubscribe) => unsubscribe())
    }
    const mounted = render(
      <LinearPicker value="https://linear.app/acme/issue/ENG-1/task" defaultSource />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
    await waitFor(() => expect(aliasLoads).toBe(1))
    queued.enabled = true
    if (outcome === 'queued') {
      await act(async () => {
        old.resolve(row('Pre-event'))
        await old.promise
      })
    }
    const oldUpdates = queued.updates.splice(0)
    const emit = () =>
      events.emit({ type: 'linearLinkedIssueUpdated', identifier: 'ENG-1', workspaceId: 'W' })
    act(emit)
    const currentUpdates = queued.updates.splice(0)
    queued.enabled = false
    expect(aliasLoads).toBe(2)
    expect(
      mocks.state.detail.mock.calls.filter(([, , workspaceId]) => workspaceId === 'W')
    ).toHaveLength(1)
    expect(controls.map((lease) => lease.currentView())).toEqual(controlViews)
    act(() => oldUpdates.forEach((update) => update()))
    expect(screen.queryByText(/Pre-event/)).toBeNull()
    act(() => currentUpdates.forEach((update) => update()))
    if (outcome !== 'queued') {
      await act(async () => {
        if (outcome === 'success') {
          old.resolve(row('Pre-event'))
        } else {
          old.reject(new Error('retired private diagnostic'))
        }
        await old.promise.catch(() => {})
      })
    }
    if (outcome === 'queued') {
      await act(async () => {
        fresh.reject(new Error('current private diagnostic'))
        await fresh.promise.catch(() => {})
      })
      await waitFor(() =>
        expect(screen.getAllByText('Unable to load Linear issues. Try again.')).toHaveLength(1)
      )
    } else {
      expect(screen.queryByText(/Pre-event/)).toBeNull()
      await act(async () => {
        fresh.resolve(row('External'))
        await fresh.promise
      })
      await waitFor(() => expect(screen.getByText(/External/)).toBeTruthy())
      expect(screen.queryByText(/Pre-event/)).toBeNull()
    }
    expect(
      mocks.state.detail.mock.calls.filter(([, , workspaceId]) => workspaceId === 'W')
    ).toHaveLength(1)
    expect(aliasLoads).toBe(2)
    control.resolve(row('Control'))
    await Promise.all(controls.map((lease) => lease.waitForCurrentTerminal()))
    controls.forEach((lease) => lease.release())
    mounted.unmount()
    act(emit)
    expect(aliasLoads).toBe(2)
  }
)
