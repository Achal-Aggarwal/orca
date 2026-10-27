import { publicRuntimeEnvironment } from '@/runtime/paired-runtime-environment-test-fixture'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRef, Profiler, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { ConfirmationDialogContext } from '../confirmation-dialog-context'
import { createTestStore, createBrowserMockApi } from '@/store/slices/browser-slice-test-harness'
import type { AppState } from '@/store/types'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { GoogleCookieClearLocalTarget } from '../../../../shared/browser-google-cookie-clear'
import type { BrowserCookieImportResult } from '../../../../shared/browser-workspace-types'

let store: ReturnType<typeof createTestStore>
const mocks = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(),
  target: vi.fn(),
  clear: vi.fn(),
  fromPartition: vi.fn()
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
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: mocks.error, warning: mocks.warning }
}))
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
  session: { fromPartition: mocks.fromPartition }
}))
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
import { BrowserSessionCookiesSection } from './BrowserSessionCookiesSection'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
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
const local: GoogleCookieClearLocalTarget = {
  profileId: 'default',
  partition: 'persist:B',
  environmentId: null,
  routeIdentity: null
}
const success: BrowserCookieImportResult = {
  ok: true,
  profileId: 'default',
  summary
}
const environment = publicRuntimeEnvironment({
  id: 'server',
  name: 'Server',
  runtimeId: 'cached-A',
  pairingRevision: 7
})

let api: ReturnType<typeof createBrowserMockApi>
function Surface({ name }: { name: string }) {
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
  if (name === 'section') {
    return <SessionSection />
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
function SessionSection() {
  const hostId = useStore(store, (s) => s.browserSessionHostIdOverride ?? 'local')
  const profiles = useStore(store, (s) => s.browserSessionProfiles)
  return (
    <BrowserSessionCookiesSection
      selectedHostId={hostId}
      defaultProfile={profiles.find((p) => p.id === 'default')}
      nonDefaultProfiles={profiles.filter((p) => p.id !== 'default')}
      detectedBrowsers={[browser]}
      importState={null}
      hostOptions={[
        { id: 'local', label: 'This computer', detail: 'Local profiles' },
        { id: 'runtime:server', label: 'Server', detail: 'Remote profiles' }
      ]}
      onAddProfile={() => {}}
      onSelectHost={(host) => void store.getState().setBrowserSessionHostId(host)}
      onSelectDefaultProfile={() => store.getState().setDefaultBrowserSessionProfileId(null)}
      onSelectProfile={store.getState().setDefaultBrowserSessionProfileId}
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
beforeEach(() => {
  vi.clearAllMocks()
  store = createTestStore()
  api = createBrowserMockApi(vi.fn())
  mocks.target.mockImplementation(async ({ profileId, environmentId }) => ({
    ...local,
    profileId,
    environmentId,
    partition: `persist:${profileId}`
  }))
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
    browserSessionProfiles: [
      profile,
      { ...profile, id: 'private', scope: 'isolated', label: 'Private' }
    ],
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
)('%s %s keeps imports and disclosure without a Google action', async (name, source) => {
  api.browser.sessionImportFromBrowser.mockResolvedValue(success)
  api.browser.sessionImportCookies.mockResolvedValue(success)
  mount(<Surface name={name} />)
  await openImport(name)
  expect(screen.getByText("Google logins aren't imported")).toBeTruthy()
  expect(screen.getByText('Sign in to Google directly in Orca.')).toBeTruthy()
  expect(screen.queryByText('Clear Google cookies…')).toBeNull()
  fireEvent.click(
    screen.getByRole('menuitem', {
      name: source === 'file' ? 'From File…' : 'From Google Chrome'
    })
  )
  await waitFor(() => expect(mocks.warning).toHaveBeenCalled())
  expect(mocks.warning.mock.calls.at(-1)?.[1]?.action).toBeUndefined()
  expect(mocks.target).not.toHaveBeenCalled()
  expect(mocks.confirm).not.toHaveBeenCalled()
})

it('canceled file import produces no warning', async () => {
  mount(<Surface name="row" />)
  await openImport('row')
  api.browser.sessionImportCookies.mockResolvedValue({ ok: false, reason: 'canceled' })
  fireEvent.click(screen.getByText('From File…'))
  await act(async () => {})
  expect(mocks.warning).not.toHaveBeenCalled()
})

it('places one Google section after the rows and clears the current Active profile', async () => {
  mount(<SessionSection />)
  const button = screen.getByRole('button', { name: 'Clear Google cookies…' })
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  expect(screen.getAllByText('Google sign-in')).toHaveLength(1)
  expect(
    screen.getByText('Google sign-in').compareDocumentPosition(screen.getByText('Private')) & 2
  ).toBe(2)
  await act(async () => fireEvent.click(button))
  expect(mocks.clear).toHaveBeenLastCalledWith(
    expect.objectContaining({ profileId: 'default', environmentId: null })
  )
  fireEvent.click(screen.getByRole('button', { name: /Private No cookies imported/ }))
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  await act(async () => fireEvent.click(button))
  expect(mocks.clear).toHaveBeenLastCalledWith(
    expect.objectContaining({ profileId: 'private', environmentId: null })
  )
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: 'Clear Google cookies from Private?' })
  )
})

it('captures the selected Host and Active profile at press through delayed capture/confirmation, cancel and repeat', async () => {
  store.setState({
    browserSessionHostIdOverride: 'runtime:server',
    defaultBrowserSessionProfileIdByHostId: { 'runtime:server': 'private' }
  })
  mount(<SessionSection />)
  const button = screen.getByRole('button', { name: 'Clear Google cookies…' })
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  const captured = Promise.withResolvers<typeof local>()
  mocks.target.mockReturnValueOnce(captured.promise)
  const confirmation = Promise.withResolvers<boolean>()
  mocks.confirm.mockReturnValueOnce(confirmation.promise)
  fireEvent.click(button)
  fireEvent.click(button)
  expect(mocks.target).toHaveBeenLastCalledWith({ profileId: 'private', environmentId: 'server' })
  await act(async () => {
    store.setState({ browserSessionHostIdOverride: 'local', defaultBrowserSessionProfileId: null })
    captured.resolve({
      ...local,
      profileId: 'private',
      environmentId: 'server',
      partition: 'persist:private'
    })
  })
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
  expect(mocks.clear).not.toHaveBeenCalled()
  await act(async () => confirmation.resolve(true))
  expect(mocks.clear).toHaveBeenLastCalledWith(
    expect.objectContaining({ profileId: 'private', environmentId: 'server' })
  )
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  mocks.confirm.mockResolvedValueOnce(false)
  await act(async () => fireEvent.click(button))
  expect(mocks.clear).toHaveBeenCalledTimes(1)
  await act(async () => fireEvent.click(button))
  expect(mocks.clear).toHaveBeenLastCalledWith(
    expect.objectContaining({ profileId: 'default', environmentId: null })
  )
  await act(async () => fireEvent.click(button))
  expect(mocks.clear).toHaveBeenCalledTimes(3)
})

it.each([10, 100])(
  'real Zustand updates cause no irrelevant section renders or IPC at N=%i',
  async (count) => {
    let renders = 0
    mount(
      <>
        {Array.from({ length: count }, (_, i) => (
          <Profiler
            key={i}
            id={String(i)}
            onRender={() => {
              renders++
            }}
          >
            <SessionSection />
          </Profiler>
        ))}
      </>
    )
    await waitFor(() => expect(mocks.target).toHaveBeenCalledTimes(count))
    await act(async () => {})
    mocks.target.mockClear()
    renders = 0
    const status = createCompatibleRuntimeStatusResponse().result
    await act(async () =>
      store.setState({
        runtimeStatusByEnvironmentId: new Map([['unrelated', { checkedAt: 2, status }]])
      })
    )
    expect(renders).toBe(0)
    expect(mocks.target).not.toHaveBeenCalled()
    expect(api.runtimeEnvironments.call).not.toHaveBeenCalled()
    await act(async () => store.getState().setDefaultBrowserSessionProfileId('private'))
    expect(renders).toBeGreaterThan(0)
    await waitFor(() => expect(mocks.target).toHaveBeenCalledTimes(count))
  }
)

it('freezes actual executor provenance through confirmation, refuses replacement and captures fresh authority', async () => {
  replaceRuntimeEnvironmentRevisions([environment])
  let executor = browserProfileRpcFixture('B').dispatcher
  let stamped = true
  let changedPairing = false
  let rows = [{ name: 'SID', domain: '.google.com', path: '/', secure: true }]
  const cookies = {
    get: vi.fn(async () =>
      rows.map((row) => ({ ...row, value: 'live', sameSite: 'unspecified' as const }))
    ),
    remove: vi.fn(async () => {
      rows = []
    })
  }
  mocks.fromPartition.mockReturnValue({ cookies })
  const status = createCompatibleRuntimeStatusResponse('cached-A').result
  store.setState({
    browserSessionHostIdOverride: 'runtime:server',
    runtimeEnvironments: [environment],
    runtimeStatusByEnvironmentId: new Map([['server', { status, checkedAt: 1 }]])
  })
  mocks.target.mockResolvedValue(null)
  api.runtimeEnvironments.call.mockImplementation(
    async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === 'status.get') {
        return { id: 'status', ok: true, result: status }
      }
      const response = await executor.dispatch({ ...request, id: 'rpc', authToken: 'fixture' })
      if (response.ok) {
        expect(response._meta?.runtimeId).toBe('D')
      }
      if (response.ok && request.method === 'browser.profileList') {
        if (!stamped && response.result && typeof response.result === 'object') {
          Reflect.deleteProperty(response.result, 'executorRuntimeId')
        }
        if (changedPairing) {
          replaceRuntimeEnvironmentRevisions([{ ...environment, pairingRevision: 8 }])
          store.setState({ runtimeEnvironments: [{ ...environment, pairingRevision: 8 }] })
        }
      }
      return response
    }
  )
  mount(<SessionSection />)
  const button = screen.getByRole('button', { name: 'Clear Google cookies…' })
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  const confirmation = Promise.withResolvers<boolean>()
  mocks.confirm.mockReturnValueOnce(confirmation.promise)
  fireEvent.click(button)
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
  executor = browserProfileRpcFixture('C').dispatcher
  await act(async () => confirmation.resolve(true))
  await waitFor(() =>
    expect(api.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'browser.profileClearGoogleCookies',
        params: { profileId: 'default', executorRuntimeId: 'B' },
        expectedEnvironmentPairingRevision: 7
      })
    )
  )
  expect(cookies.get).not.toHaveBeenCalled()
  expect(mocks.clear).not.toHaveBeenCalled()
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  fireEvent.click(button)
  await waitFor(() => expect(cookies.remove).toHaveBeenCalledTimes(1))
  expect(api.runtimeEnvironments.call).toHaveBeenLastCalledWith(
    expect.objectContaining({
      method: 'browser.profileClearGoogleCookies',
      params: { profileId: 'default', executorRuntimeId: 'C' }
    })
  )
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  fireEvent.click(button)
  await waitFor(() => expect(cookies.get).toHaveBeenCalledTimes(3))
  for (const mode of ['missing stamp', 'old daemon', 'unknown R', 'changed R']) {
    stamped = mode !== 'missing stamp'
    changedPairing = mode === 'changed R'
    replaceRuntimeEnvironmentRevisions(mode === 'unknown R' ? [] : [environment])
    act(() =>
      store.setState({
        runtimeEnvironments: [environment],
        runtimeStatusByEnvironmentId: new Map([
          [
            'server',
            {
              checkedAt: 2,
              status: {
                ...status,
                capabilities: mode === 'old daemon' ? [] : status.capabilities
              }
            }
          ]
        ])
      })
    )
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(mode === 'old daemon'))
    const confirms = mocks.confirm.mock.calls.length
    if (mode !== 'old daemon') {
      fireEvent.click(button)
      await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    }
    expect(mocks.confirm).toHaveBeenCalledTimes(confirms)
    expect(cookies.get).toHaveBeenCalledTimes(3)
    expect(cookies.remove).toHaveBeenCalledTimes(1)
  }
})

it.each(['same host', 'changed host', 'changed pairing'])(
  'keeps pressed-target provenance through overlapping list overlay: %s',
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
    mount(<SessionSection />)
    const button = screen.getByRole('button', { name: 'Clear Google cookies…' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(overlayReader).toHaveBeenCalledTimes(1))
    await act(async () => {
      await store.getState().fetchBrowserSessionProfiles('runtime:server')
    })
    if (change === 'changed pairing') {
      replaceRuntimeEnvironmentRevisions([{ ...environment, pairingRevision: 8 }])
      act(() => store.setState({ runtimeEnvironments: [{ ...environment, pairingRevision: 8 }] }))
    } else if (change === 'changed host') {
      act(() => store.setState({ browserSessionHostIdOverride: 'local' }))
    }
    await act(async () => overlay.resolve({}))
    expect(store.getState().browserSessionProfilesByHostId['runtime:server']).toHaveLength(2)
    const clears = api.runtimeEnvironments.call.mock.calls.filter(
      ([request]) => request.method === 'browser.profileClearGoogleCookies'
    )
    if (change === 'changed pairing') {
      expect(clears).toHaveLength(0)
      expect(mocks.confirm).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
      expect(clears).toEqual([
        [
          expect.objectContaining({
            params: { profileId: 'default', executorRuntimeId: 'S1' },
            expectedEnvironmentPairingRevision: 7
          })
        ]
      ])
    }
    expect(
      api.runtimeEnvironments.call.mock.calls.filter(
        ([request]) => request.method === 'browser.profileList'
      )
    ).toHaveLength(2)
  }
)
