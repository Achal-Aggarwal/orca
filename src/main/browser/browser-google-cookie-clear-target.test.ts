import type * as ClientHostRuntime from './paired-runtime-browser-client-host-runtime'
import { publicRuntimeEnvironment } from '../../renderer/src/runtime/paired-runtime-environment-test-fixture'
import { z } from 'zod'
import type { GoogleCookieClearLocalTarget } from '../../shared/browser-google-cookie-clear'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'

const mocks = vi.hoisted(() => ({
  root: '',
  route: vi.fn(),
  profiles: new Map<string, BrowserSessionProfile>(),
  sessions: new Map<string, ReturnType<typeof jar>>(),
  import: vi.fn(),
  detect: vi.fn(),
  pick: vi.fn(),
  handlers: new Map<string, (event: { sender: unknown }, args: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
  BrowserWindow: { fromWebContents: () => null },
  session: { fromPartition: (partition: string) => mocks.sessions.get(partition) },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: (channel: string, handler: (event: { sender: unknown }, args: unknown) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('./paired-runtime-browser-client-host-runtime', () => ({
  getPairedRuntimeBrowserClientRouteIdentity: mocks.route
}))
vi.mock('./cookies/browser-cookie-import', () => ({
  importCookiesFromBrowser: mocks.import,
  importCookiesFromFile: mocks.import,
  pickCookieFile: mocks.pick,
  detectInstalledBrowsers: mocks.detect,
  selectBrowserProfile: vi.fn()
}))
vi.mock('./browser-manager', () => ({ browserManager: {} }))
vi.mock('./client-route-cookie-import-source-store', () => ({
  recordClientRouteCookieImportSource: vi.fn()
}))
import { browserSessionRegistry } from './browser-session-registry'
vi.mock('./paired-runtime-browser-client-host-registry', () => ({
  PairedRuntimeBrowserClientHostRegistry: class {
    start = async () => ({})
    closeEnvironment = async () => true
    retireEnvironment = async () => true
  }
}))
import { registerBrowserHandlers } from '../ipc/browser'
import { setTrustedBrowserRendererWebContentsId } from '../ipc/browser-renderer-trust'
import {
  bindRoutePartition,
  importCookiesIntoClientRoutePartition
} from './browser-client-route-cookie-import'
import { clearGoogleCookies } from './cookies/browser-google-cookie-clear'
import { acquireCookieMutationLock } from './cookies/browser-cookie-import-clear'
import { deriveBrowserRoutePartition } from './browser-route-identity'
import * as bindingFile from './browser-route-partition-binding-file'

const profile: BrowserSessionProfile = {
  id: 'work',
  partition: 'persist:work',
  label: 'Work',
  scope: 'isolated',
  source: null
}
const route = {
  orcaProfileId: 'orca',
  authorityConnectionIdentity: 'new',
  pairingAuthorityConnectionIdentity: 'old',
  legacyAuthorityConnectionIdentity: 'legacy',
  executionHostIdentity: 'desktop',
  legacyExecutionHostIdentity: 'legacy-desktop',
  storageScope: 'a'.repeat(64)
}
const request = { environmentId: 'server', browserProfileId: 'work', browserFamily: 'chrome' }
const targetSchema = z.object({
  profileId: z.string(),
  environmentId: z.string().nullable(),
  partition: z.string(),
  routeIdentity: z.string().nullable()
})
function call(channel: string, args: unknown, senderId = 91) {
  const handler = mocks.handlers.get(`browser:session:${channel}`)
  if (!handler) {
    throw new Error('missing IPC handler')
  }
  return handler(
    {
      sender: {
        id: senderId,
        isDestroyed: () => false,
        getType: () => 'window',
        getURL: () => 'file:///renderer/index.html'
      }
    },
    args
  )
}
function jar(count = 1) {
  let rows = [
    ...Array.from({ length: count }, (_, i) => ({
      name: `SID${i}`,
      domain: '.google.com',
      path: '/',
      secure: true
    })),
    { name: 'other', domain: 'example.com', path: '/', secure: true }
  ]
  const cookies = {
    get: vi.fn(async () => rows),
    remove: vi.fn(async (_url: string, name: string) => {
      rows = rows.filter((row) => row.name !== name)
    })
  }
  return { cookies }
}
beforeEach(() => {
  mocks.root = mkdtempSync(join(tmpdir(), 'pr34158-binding-'))
  mocks.profiles.clear()
  mocks.profiles.set(profile.id, { ...profile })
  mocks.sessions.clear()
  mocks.route.mockReturnValue(route)
  mocks.detect.mockReturnValue([])
  mocks.import.mockResolvedValue({ ok: true, summary: {} })
  mocks.pick.mockResolvedValue('/fixture/cookies.json')
  vi.spyOn(browserSessionRegistry, 'getProfile').mockImplementation(
    (id) => mocks.profiles.get(id) ?? null
  )
  vi.spyOn(browserSessionRegistry, 'listProfiles').mockImplementation(() => [
    ...mocks.profiles.values()
  ])
  vi.spyOn(browserSessionRegistry, 'updateProfileSource').mockReturnValue(null)
  vi.spyOn(browserSessionRegistry, 'requireRouteBrowserProfile').mockImplementation((id) => {
    if (!mocks.profiles.has(id)) {
      throw new Error('profile unavailable')
    }
  })
  setTrustedBrowserRendererWebContentsId(91)
  registerBrowserHandlers()
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(mocks.root, { recursive: true, force: true })
})

it('preserves import refusal/order, reserves delegation for absent routes, and rejects forged/untrusted IPC', async () => {
  const server = jar()
  mocks.sessions.set('persist:server', server)
  mocks.profiles.delete('work')
  expect(await importCookiesIntoClientRoutePartition(request)).toEqual({
    ok: false,
    reason: 'Session profile not found.'
  })
  expect(() =>
    call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })
  ).toThrow()
  expect(server.cookies.remove).not.toHaveBeenCalled()
  mocks.route.mockReturnValue(null)
  expect(call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })).toBeNull()
  expect(await importCookiesIntoClientRoutePartition(request)).toBeNull()
  mocks.profiles.set('work', profile)
  mocks.route.mockReturnValue(route)
  expect(await importCookiesIntoClientRoutePartition(request)).toEqual({
    ok: false,
    reason: 'Browser not found on this system.'
  })
  const target: GoogleCookieClearLocalTarget = targetSchema.parse(
    call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })
  )
  expect(() => call('clearGoogleCookies', { ...target, partition: 'persist:server' })).toThrow()
  expect(() => call('clearGoogleCookies', target, 92)).toThrow('Not authorized')
  expect(() => call('clearGoogleCookies', {})).toThrow()
  expect(() => call('clearGoogleCookies', { ...target, routeIdentity: 'forged' })).toThrow()
  expect(
    call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' }, 92)
  ).toBeNull()
  expect(() =>
    call('googleCookieClearTarget', { profileId: 'unknown', environmentId: null })
  ).toThrow()
  expect(server.cookies.get).not.toHaveBeenCalled()
})

it.each([
  [10, 50],
  [100, 500]
])(
  'bounds real binding-file work at K=%i B=%i and preserves alias-selected/non-Google jars',
  async (count, bindings) => {
    const entries = Object.fromEntries(
      Array.from({ length: bindings - 1 }, (_, i) => {
        const d = deriveBrowserRoutePartition({ ...route, browserProfileId: `unused-${i}` })
        return [
          d.partition,
          { fingerprint: d.bindingFingerprint, storageScope: route.storageScope, lastUsedAt: 1 }
        ]
      })
    )
    const compatible = deriveBrowserRoutePartition({
      ...route,
      browserProfileId: 'work',
      authorityConnectionIdentity: route.pairingAuthorityConnectionIdentity
    })
    entries[compatible.partition] = {
      fingerprint: compatible.bindingFingerprint,
      storageScope: route.storageScope,
      lastUsedAt: 1
    }
    writeFileSync(
      join(mocks.root, 'browser-route-partition-bindings.json'),
      JSON.stringify({ version: 2, bindings: entries })
    )
    const partition = bindRoutePartition(route, 'work')
    expect(partition).toBe(compatible.partition)
    const target: GoogleCookieClearLocalTarget = targetSchema.parse(
      call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })
    )
    const session = jar(count)
    session.cookies.get.mockResolvedValueOnce([
      ...(await session.cookies.get()),
      { name: 'SID0', domain: '.google.com', path: '/', secure: true }
    ])
    session.cookies.get.mockClear()
    const decoy = jar()
    mocks.sessions.set(partition, session)
    mocks.sessions.set(profile.partition, decoy)
    const read = vi.spyOn(bindingFile, 'readBoundedUtf8File')
    expect(await call('clearGoogleCookies', target)).toBe('cleared')
    expect(read).toHaveBeenCalledTimes(4)
    expect(session.cookies.get).toHaveBeenCalledTimes(2)
    expect(session.cookies.remove).toHaveBeenCalledTimes(count)
    expect(await session.cookies.get()).toEqual([expect.objectContaining({ name: 'other' })])
    expect(decoy.cookies.get).not.toHaveBeenCalled()
    session.cookies.get.mockClear()
    expect(await call('clearGoogleCookies', target)).toBe('empty')
    expect(session.cookies.get).toHaveBeenCalledTimes(1)
  }
)

it.each(['between selectors', 'queued profile'])(
  'stops mutation after changed ownership: %s',
  async (change) => {
    const target: GoogleCookieClearLocalTarget = targetSchema.parse(
      call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })
    )
    const session = jar(2)
    mocks.sessions.set(target.partition, session)
    if (change === 'between selectors') {
      session.cookies.remove.mockImplementationOnce(async () => {
        mocks.route.mockReturnValue({ ...route })
      })
      expect(await call('clearGoogleCookies', target)).toBe('unverified')
      expect(session.cookies.remove).toHaveBeenCalledTimes(1)
    } else {
      const release = await acquireCookieMutationLock(session)
      const clearing = call('clearGoogleCookies', target)
      mocks.profiles.delete('work')
      release()
      await expect(clearing).rejects.toThrow('connection changed')
      expect(session.cookies.get).not.toHaveBeenCalled()
    }
  }
)

import { browserProfileRpcFixture } from '../runtime/browser/browser-profile-rpc-test-fixture'
it('validates required executor params at the dispatcher before owner entry', async () => {
  const { profiles: first, dispatcher } = browserProfileRpcFixture('S1')
  const clear = vi.spyOn(first, 'browserProfileClearGoogleCookies')
  expect(
    await dispatcher.dispatch({
      id: 'clear',
      authToken: 'fixture',
      method: 'browser.profileClearGoogleCookies',
      params: { profileId: 'work' }
    })
  ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  expect(clear).not.toHaveBeenCalled()
  await expect(
    first.browserProfileClearGoogleCookies({ profileId: 'absent', executorRuntimeId: 'S1' })
  ).rejects.toThrow('not found')
})

it.each(['reject after delete', 'first read', 'last read'])(
  'reports observed cookie truth through the selected Session: %s',
  async (fault) => {
    const session = jar(2)
    const remove = session.cookies.remove.getMockImplementation()!
    if (fault === 'reject after delete') {
      session.cookies.remove.mockImplementationOnce(async (url, name) => {
        await remove(url, name)
        throw new Error('deleted then rejected')
      })
    }
    if (fault === 'first read' || fault === 'last read') {
      if (fault === 'last read') {
        session.cookies.get.mockResolvedValueOnce(await session.cookies.get())
      }
      session.cookies.get.mockRejectedValueOnce(new Error('read failed'))
    }
    expect(await clearGoogleCookies(session)).toBe(
      fault.includes('read') ? 'unverified' : 'cleared'
    )
    if (!fault.includes('read')) {
      expect(session.cookies.remove).toHaveBeenCalledTimes(2)
    }
  }
)

it('retains actual local/file/client import destinations, source-only replacement, and real route retirement', async () => {
  vi.mocked(browserSessionRegistry.getProfile).mockRestore()
  vi.mocked(browserSessionRegistry.updateProfileSource).mockRestore()
  vi.mocked(browserSessionRegistry.requireRouteBrowserProfile).mockRestore()
  browserSessionRegistry.configureForOrcaProfile({
    orcaProfileId: 'orca',
    profileDirectory: mocks.root
  })
  const selected = browserSessionRegistry.getDefaultProfile()
  mocks.detect.mockReturnValue([{ family: 'chrome', selectedProfile: 'Default', profiles: [] }])
  for (const channel of ['importCookies', 'importFromBrowser']) {
    expect(await call(channel, { profileId: 'default', browserFamily: 'chrome' })).toMatchObject({
      ok: true,
      googleCookieClearTarget: { local: { partition: selected.partition } }
    })
    expect(mocks.import.mock.calls.at(-1)?.[1]).toBe(selected.partition)
  }
  const runtime = await vi.importActual<typeof ClientHostRuntime>(
    './paired-runtime-browser-client-host-runtime'
  )
  runtime.configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'orca' })
  await runtime.startPairedRuntimeBrowserClientHost({
    authorityRuntimeId: 'D',
    environment: {
      ...publicRuntimeEnvironment({ id: 'server', runtimeId: 'D' }),
      endpoints: [
        {
          id: 'ws-1',
          kind: 'websocket',
          label: 'Fixture',
          endpoint: 'ws://localhost:9999',
          deviceToken: 'fixture',
          publicKeyB64: 'fixture'
        }
      ]
    }
  })
  mocks.route.mockImplementation(runtime.getPairedRuntimeBrowserClientRouteIdentity)
  const result = await importCookiesIntoClientRoutePartition({
    ...request,
    browserProfileId: 'default'
  })
  const target = targetSchema.parse(result?.ok ? result.googleCookieClearTarget?.local : null)
  expect(target.partition).toBe(mocks.import.mock.calls.at(-1)?.[1])
  const session = jar(2)
  mocks.sessions.set(target.partition, session)
  session.cookies.remove.mockImplementationOnce(async () => {
    browserSessionRegistry.updateProfileSource('default', {
      browserFamily: 'manual',
      importedAt: 1
    })
  })
  expect(await call('clearGoogleCookies', target)).toBe('remaining')
  expect(session.cookies.remove).toHaveBeenCalledTimes(2)
  expect(browserSessionRegistry.getProfile('default')).not.toBe(selected)
  const release = await acquireCookieMutationLock(session)
  const clearing = call('clearGoogleCookies', target)
  await runtime.retirePairedRuntimeBrowserClientHostEnvironment('server')
  session.cookies.get.mockClear()
  release()
  await expect(clearing).rejects.toThrow('connection changed')
  expect(session.cookies.get).not.toHaveBeenCalled()
  writeFileSync(join(mocks.root, 'browser-route-partition-bindings.json'), 'corrupt')
  mocks.route.mockReturnValue(route)
  const read = vi.spyOn(bindingFile, 'readBoundedUtf8File')
  expect(
    await importCookiesIntoClientRoutePartition({
      ...request,
      browserProfileId: 'default',
      browserProfile: '../invalid'
    })
  ).toMatchObject({ ok: false, reason: 'Invalid browser profile name.' })
  expect(read).not.toHaveBeenCalled()
})
