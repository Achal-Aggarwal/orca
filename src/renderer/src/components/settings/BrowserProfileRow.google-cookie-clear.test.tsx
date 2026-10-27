import { publicRuntimeEnvironment } from '@/runtime/paired-runtime-environment-test-fixture'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRef, type ReactNode } from 'react'
import { ConfirmationDialogContext } from '../confirmation-dialog-context'
import { createTestStore, createBrowserMockApi } from '@/store/slices/browser-slice-test-harness'
import type { AppState } from '@/store/types'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { BrowserCookieImportResult } from '../../../../shared/browser-workspace-types'

let store: ReturnType<typeof createTestStore>
const mocks = vi.hoisted(() => ({
  warning: vi.fn(),
  confirm: vi.fn(),
  target: vi.fn(),
  clear: vi.fn()
}))
vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  return {
    useAppStore: Object.assign(
      (selector: (state: AppState) => unknown) => useStore(store, selector),
      { getState: () => store.getState() }
    )
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: mocks.warning } }))
vi.mock('../BrowserCookieImportMachineNotice', () => ({
  BrowserCookieImportMachineNotice: () => null
}))
vi.mock('../../../../main/browser/browser-manager', () => ({ browserManager: {} }))
vi.mock('../../../../main/browser/browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: () => profile,
    listProfiles: () => [profile],
    updateProfileSource: vi.fn()
  }
}))
vi.mock('../../../../main/browser/cookies/browser-cookie-import', () => ({
  detectInstalledBrowsers: () => [browser],
  importCookiesFromBrowser: async () => success,
  selectBrowserProfile: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {},
  session: { fromPartition: vi.fn() }
}))
import { session } from 'electron'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'

type ProfileDispatcher = {
  dispatch(request: {
    id: string
    authToken: string
    method: string
    params?: Record<string, unknown>
  }): Promise<RuntimeRpcResponse<unknown>>
}
const { browserProfileRpcFixture } = await vi.importActual<{
  browserProfileRpcFixture(executorRuntimeId: string): { dispatcher: ProfileDispatcher }
}>('../../../../main/runtime/browser/browser-profile-rpc-test-fixture')

import { BrowserProfileRow } from './BrowserProfileRow'
import { BrowserUseCookieImportStep } from './BrowserUseCookieImportStep'
import { BrowserImportHintButton } from '../browser-pane/assemble-chrome/BrowserImportHintButton'
import { BrowserToolbarMenu } from '../browser-pane/assemble-chrome/BrowserToolbarMenu'

const profile = {
  id: 'default',
  label: 'Default',
  partition: 'persist:A',
  scope: 'default',
  source: null
} as const
const browser = {
  family: 'chrome',
  label: 'Google Chrome',
  profiles: [{ name: 'Default', directory: 'Default' }],
  selectedProfile: 'Default'
}
const summary = {
  totalCookies: 1,
  importedCookies: 0,
  skippedCookies: 1,
  googleCookiesSkipped: 1,
  domains: []
}
const local = {
  profileId: 'default',
  partition: 'persist:B',
  environmentId: null,
  routeIdentity: null
}
const success: BrowserCookieImportResult = {
  ok: true,
  profileId: 'default',
  summary,
  googleCookieClearTarget: { local, label: '' }
}
const environment = publicRuntimeEnvironment({
  id: 'server',
  name: 'Server',
  runtimeId: 'cached-A',
  pairingRevision: 7
})

let api: ReturnType<typeof createBrowserMockApi>
function surface(name: string) {
  if (name === 'row') {
    return (
      <BrowserProfileRow
        profile={profile}
        detectedBrowsers={[browser]}
        importState={null}
        isActive
        onSelect={() => {}}
      />
    )
  }
  if (name === 'setup') {
    return (
      <BrowserUseCookieImportStep
        cookiesImported={false}
        isImportingDefault={false}
        sourceLabel={null}
      />
    )
  }
  if (name === 'hint') {
    return <BrowserImportHintButton profileId="default" />
  }
  return (
    <BrowserToolbarMenu
      currentProfileId="default"
      workspaceId="workspace"
      browserPageId="page"
      viewportPresetId={null}
      onDestroyWebview={() => {}}
      isActive
      overflow={{
        triggerRef: createRef(),
        tools: [],
        deferUntilClose: vi.fn(),
        onMenuCloseAutoFocus: vi.fn()
      }}
    />
  )
}
function mount(node: ReactNode) {
  return render(
    <ConfirmationDialogContext.Provider value={mocks.confirm}>
      {node}
    </ConfirmationDialogContext.Provider>
  )
}
async function openImport(name: string) {
  if (screen.queryByRole('menuitem', { name: 'From File…' })) {
    return
  }
  if (name === 'hint') {
    fireEvent.click(screen.getByRole('button', { name: 'Import browser data' }))
  }
  const trigger =
    name === 'toolbar'
      ? screen.getByTitle('Browser menu')
      : screen.getAllByRole('button', {
          name: name === 'row' ? 'Import Cookies' : name === 'hint' ? 'Import…' : 'Import'
        })[0]
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  if (name === 'toolbar') {
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'Import Cookies' }), {
      key: 'ArrowRight'
    })
  }
  await screen.findByRole('menuitem', { name: 'From File…' })
}
function warningAction() {
  const options = mocks.warning.mock.calls.findLast((call) => call[1]?.action)?.[1]
  expect(options?.action.label).toBe('Clear Google cookies…')
  return options.action.onClick
}
beforeEach(() => {
  vi.clearAllMocks()
  store = createTestStore()
  api = createBrowserMockApi(vi.fn())
  mocks.target.mockResolvedValue({ ...local, partition: 'persist:A' })
  mocks.clear.mockResolvedValue('cleared')
  mocks.confirm.mockResolvedValue(true)
  api.browser.sessionListProfiles.mockResolvedValue([])
  Object.assign(api.browser, {
    sessionGoogleCookieClearTarget: mocks.target,
    getPageSiteDisplay: vi.fn(async () => null),
    sessionClearGoogleCookies: mocks.clear
  })
  Object.assign(window, { api })
  store.setState({
    settingsSearchQuery: '',
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    browserSessionProfiles: [],
    persistedUIReady: true,
    browserImportHintHidden: false,
    detectedBrowsers: [browser],
    detectedBrowsersLoaded: true,
    fetchDetectedBrowsers: vi.fn(async () => {})
  })
})
afterEach(() => {
  cleanup()
  replaceRuntimeEnvironmentRevisions([])
  clearRuntimeCompatibilityCacheForTests()
})

it.each(
  ['row', 'setup', 'hint', 'toolbar'].flatMap((name) =>
    ['browser', 'file'].map((source) => [name, source])
  )
)(
  '%s %s callback uses the successful B receipt, not pre-import A or later Settings',
  async (name, source) => {
    const imported = Promise.withResolvers<BrowserCookieImportResult>()
    api.browser.sessionImportFromBrowser.mockReturnValue(imported.promise)
    api.browser.sessionImportCookies.mockReturnValue(imported.promise)
    mount(surface(name))
    await openImport(name)
    expect(screen.getByText("Google logins aren't imported")).toBeTruthy()
    expect(screen.getByText('Sign in to Google directly in Orca.')).toBeTruthy()
    if (name === 'hint' || name === 'toolbar') {
      expect(screen.queryByText('Clear Google cookies…')).toBeNull()
    }
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: source === 'file' ? 'From File…' : 'From Google Chrome'
      })
    )
    await act(async () => {
      store.setState({ browserSessionHostIdOverride: 'runtime:other' })
      imported.resolve(success)
    })
    act(() => store.setState({ browserSessionHostIdOverride: 'runtime:third' }))
    mocks.confirm.mockResolvedValueOnce(false)
    await act(async () => warningAction()())
    expect(mocks.clear).not.toHaveBeenCalled()
    const confirm = Promise.withResolvers<boolean>()
    mocks.confirm.mockReturnValueOnce(confirm.promise)
    act(() => {
      warningAction()()
      warningAction()()
    })
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2))
    expect(mocks.clear).not.toHaveBeenCalled()
    await act(async () => {
      store.setState({ browserSessionHostIdOverride: 'local' })
      confirm.resolve(true)
    })
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledWith(local))
    const calls = mocks.target.mock.calls.length
    expect(name === 'hint' || name === 'toolbar' ? calls : 0).toBe(0)
  }
)

it('canceled file import produces no warning', async () => {
  mount(surface('row'))
  await openImport('row')
  api.browser.sessionImportCookies.mockResolvedValue({ ok: false, reason: 'canceled' })
  fireEvent.click(screen.getByText('From File…'))
  await act(async () => {})
  expect(mocks.warning).not.toHaveBeenCalled()
})

it.each([10, 100])(
  'real Zustand updates cause no irrelevant resolution at N=%i and panes have no eager work',
  async (count) => {
    replaceRuntimeEnvironmentRevisions([environment])
    mocks.target.mockResolvedValue(null)
    const status = createCompatibleRuntimeStatusResponse().result
    store.setState({
      browserSessionHostIdOverride: 'runtime:server',
      runtimeEnvironments: [environment],
      runtimeStatusByEnvironmentId: new Map([['server', { checkedAt: 1, status }]])
    })
    const dispatcher = browserProfileRpcFixture('B').dispatcher
    api.runtimeEnvironments.call.mockImplementation(async (request: { method: string }) =>
      request.method === 'status.get'
        ? createCompatibleRuntimeStatusResponse()
        : dispatcher.dispatch({ ...request, id: 'rpc', authToken: 'fixture' })
    )
    mount(
      <>
        {Array.from({ length: count }, (_, i) => (
          <div key={i}>
            {surface('row')}
            {surface('hint')}
            {surface('toolbar')}
          </div>
        ))}
      </>
    )
    await waitFor(() => expect(mocks.target).toHaveBeenCalledTimes(count))
    mocks.target.mockClear()
    expect(api.runtimeEnvironments.call).not.toHaveBeenCalled()
    await act(async () => {
      store.setState({
        runtimeStatusByEnvironmentId: new Map(store.getState().runtimeStatusByEnvironmentId)
          .set('unrelated', { checkedAt: 2, status })
          .set('server', { checkedAt: 2, status: { ...status, liveTabCount: 99 } })
      })
    })
    expect(mocks.target).not.toHaveBeenCalled()
    expect(api.runtimeEnvironments.call).not.toHaveBeenCalled()
    await openImport('row')
    await waitFor(() => expect(mocks.target).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(
        api.runtimeEnvironments.call.mock.calls.filter(
          ([request]) => request.method === 'browser.profileList'
        )
      ).toHaveLength(1)
    )
  }
)

import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
it.each(['warning', 'menu', 'confirmation'])(
  'retains %s authority across actual executor replacement and captures fresh provenance',
  async (held) => {
    replaceRuntimeEnvironmentRevisions([environment])
    let executor = browserProfileRpcFixture('B').dispatcher
    let rows = [{ name: 'SID', domain: '.google.com', path: '/', secure: true }]
    const cookies = {
      get: vi.fn(async () =>
        rows.map((row) => ({ ...row, value: 'live', sameSite: 'unspecified' as const }))
      ),
      remove: vi.fn(async () => {
        rows = []
      })
    }
    vi.mocked(session.fromPartition).mockReturnValue(
      // SAFETY: the real clear primitive only accesses this Session's cookie API.
      { cookies } as ReturnType<typeof session.fromPartition>
    )
    let stamped = true
    let repaired = false
    const status = createCompatibleRuntimeStatusResponse('cached-A').result
    store.setState({
      browserSessionHostIdOverride: 'runtime:server',
      runtimeEnvironments: [environment],
      runtimeStatusByEnvironmentId: new Map([['server', { status, checkedAt: 1 }]])
    })
    mocks.target.mockResolvedValue(null)
    api.runtimeEnvironments.call.mockImplementation(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (repaired && request.method === 'browser.profileImportFromBrowser') {
          store.setState({ runtimeEnvironments: [{ ...environment, pairingRevision: 8 }] })
        }
        if (request.method === 'status.get') {
          return { id: 'status', ok: true, result: status }
        }
        const response = await executor.dispatch({ ...request, id: 'rpc', authToken: 'fixture' })
        if (response.ok) {
          expect(response._meta?.runtimeId).toBe('D')
        }
        if (response.ok && !stamped && response.result && typeof response.result === 'object') {
          Reflect.deleteProperty(response.result, 'executorRuntimeId')
        }
        return response
      }
    )
    mount(surface('row'))
    await openImport('row')
    fireEvent.click(screen.getByText('From Google Chrome'))
    await waitFor(() => expect(mocks.warning).toHaveBeenCalled())
    expect(api.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'browser.profileImportFromBrowser',
        params: {
          profileId: 'default',
          browserFamily: 'chrome',
          browserProfile: undefined,
          supportsPartitionSkippedCookies: true
        },
        expectedEnvironmentPairingRevision: 7
      })
    )
    const oldWarning = warningAction()
    if (held === 'warning') {
      act(() => oldWarning())
      await waitFor(() => expect(cookies.get).toHaveBeenCalledTimes(2))
      expect(cookies.remove).toHaveBeenCalledTimes(1)
      rows = [{ name: 'SID', domain: '.google.com', path: '/', secure: true }]
      cookies.remove.mockClear()
      api.runtimeEnvironments.call.mockClear()
    }
    const confirmation = Promise.withResolvers<boolean>()
    if (held === 'menu') {
      await openImport('row')
      await waitFor(() =>
        expect(screen.getByText('Clear Google cookies…').hasAttribute('data-disabled')).toBe(false)
      )
    }
    if (held === 'confirmation') {
      mocks.confirm.mockReturnValueOnce(confirmation.promise)
      act(() => oldWarning())
      await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    }
    executor = browserProfileRpcFixture('C').dispatcher
    cookies.get.mockClear()
    if (held === 'menu') {
      fireEvent.click(screen.getByText('Clear Google cookies…'))
    } else if (held === 'warning') {
      act(() => oldWarning())
    } else {
      await act(async () => confirmation.resolve(true))
    }
    await waitFor(() =>
      expect(api.runtimeEnvironments.call).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'browser.profileClearGoogleCookies',
          params: { profileId: 'default', executorRuntimeId: 'B' },
          expectedEnvironmentPairingRevision: 7,
          expectedEnvironmentRuntimeId: undefined
        })
      )
    )
    expect(cookies.get).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    await openImport('row')
    const menu = await screen.findByRole('menuitem', { name: 'Clear Google cookies…' })
    await waitFor(() => expect(menu.hasAttribute('data-disabled')).toBe(false))
    fireEvent.click(menu)
    await waitFor(() =>
      expect(api.runtimeEnvironments.call).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'browser.profileClearGoogleCookies',
          params: { profileId: 'default', executorRuntimeId: 'C' }
        })
      )
    )
    await waitFor(() => expect(cookies.get).toHaveBeenCalledTimes(2))
    await openImport('row')
    const repeat = await screen.findByRole('menuitem', { name: 'Clear Google cookies…' })
    await waitFor(() => expect(repeat.hasAttribute('data-disabled')).toBe(false))
    fireEvent.click(repeat)
    await waitFor(() => expect(cookies.get).toHaveBeenCalledTimes(3))
    for (const mode of ['missing stamp', 'old daemon', 'unknown R', 'changed R']) {
      stamped = mode !== 'missing stamp'
      repaired = mode === 'changed R'
      replaceRuntimeEnvironmentRevisions(mode === 'unknown R' ? [] : [environment])
      act(() =>
        store.setState({
          runtimeEnvironments: [environment],
          runtimeStatusByEnvironmentId: new Map([
            [
              'server',
              {
                checkedAt: 1,
                status: {
                  ...status,
                  capabilities: mode === 'old daemon' ? [] : status.capabilities
                }
              }
            ]
          ])
        })
      )
      mocks.warning.mockClear()
      await openImport('row')
      if (mode === 'missing stamp') {
        await waitFor(() => expect(screen.queryByText('Clear Google cookies…')).toBeNull())
      }
      fireEvent.click(screen.getByText('From Google Chrome'))
      await waitFor(() => expect(mocks.warning).toHaveBeenCalled())
      expect(mocks.warning.mock.calls.at(-1)?.[1].action).toBeUndefined()
    }
  }
)

it.each(['same host', 'changed host', 'changed pairing'])(
  'keeps operation provenance through overlapping overlay: %s',
  async (change) => {
    replaceRuntimeEnvironmentRevisions([environment])
    const status = createCompatibleRuntimeStatusResponse().result
    store.setState({
      browserSessionHostIdOverride: 'runtime:server',
      runtimeEnvironments: [environment],
      runtimeStatusByEnvironmentId: new Map([['server', { status, checkedAt: 1 }]])
    })
    mocks.target.mockResolvedValue(null)
    let listing = 0
    api.runtimeEnvironments.call.mockImplementation(async ({ method }: { method: string }) => ({
      id: 'rpc',
      ok: true,
      result:
        method === 'status.get'
          ? status
          : {
              profiles: listing++ ? [profile, { ...profile, id: 'new' }] : [profile],
              executorRuntimeId: listing === 1 ? 'S1' : 'S2'
            }
    }))
    const overlay = Promise.withResolvers<Record<string, never>>()
    const overlayReader = vi.fn().mockReturnValueOnce(overlay.promise).mockResolvedValue({})
    Object.assign(api.browser, { sessionClientRouteImportSources: overlayReader })
    mount(surface('row'))
    await openImport('row')
    await waitFor(() => expect(overlayReader).toHaveBeenCalledTimes(1))
    await act(async () => {
      await store.getState().fetchBrowserSessionProfiles('runtime:server')
    })
    if (change === 'changed pairing') {
      replaceRuntimeEnvironmentRevisions([{ ...environment, pairingRevision: 8 }])
    }
    if (change !== 'same host') {
      act(() =>
        store.setState(
          change === 'changed host'
            ? { browserSessionHostIdOverride: 'local' }
            : { runtimeEnvironments: [{ ...environment, pairingRevision: 8 }] }
        )
      )
    }
    await act(async () => {
      overlay.resolve({})
    })
    expect(store.getState().browserSessionProfilesByHostId['runtime:server']).toHaveLength(2)
    if (change !== 'changed host') {
      const menu = await screen.findByRole('menuitem', { name: 'Clear Google cookies…' })
      await waitFor(() => expect(menu.hasAttribute('data-disabled')).toBe(false))
      fireEvent.click(menu)
      await waitFor(() =>
        expect(api.runtimeEnvironments.call).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'browser.profileClearGoogleCookies',
            params: {
              profileId: 'default',
              executorRuntimeId: change === 'same host' ? 'S1' : 'S2'
            },
            expectedEnvironmentPairingRevision: change === 'same host' ? 7 : 8
          })
        )
      )
    } else {
      await waitFor(() => expect(screen.queryByText('Clear Google cookies…')).toBeNull())
    }
    expect(
      api.runtimeEnvironments.call.mock.calls.filter(
        ([request]) => request.method === 'browser.profileList'
      )
    ).toHaveLength(change === 'changed pairing' ? 3 : 2)
  }
)
