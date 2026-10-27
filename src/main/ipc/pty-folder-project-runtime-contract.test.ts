import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../shared/constants'
import { MIXED_FOLDER, MIXED_GROUP } from '../../shared/folder-workspace-host-routing.test-fixture'
import { setupPtyIpcSuite } from './pty/pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { createInitialStoreState } from '../../renderer/src/components/terminal-pane/pty-connection-test-store-fixtures'
import {
  createMockTransport,
  createPane,
  createManager
} from '../../renderer/src/components/terminal-pane/pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from '../../renderer/src/components/terminal-pane/pty-connection-test-deps'
import { flushAsyncTicks } from '../../renderer/src/components/terminal-pane/pty-connection-test-async'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../../renderer/src/components/terminal-pane/pty-connection-test-environment'
import type { StoreState } from '../../renderer/src/components/terminal-pane/pty-connection-test-store-state'
import type { IpcPtyTransportOptions } from '../../renderer/src/components/terminal-pane/pty-transport-types'
import { createTestStore, makeTab } from '../../renderer/src/store/slices/store-test-helpers'
import { existsSyncMock, wslUncDirectoryExistsAsyncMock } from './pty/pty-ipc-mock-registry'
import { _setWslCachesForTests, _resetWslCachesForTests } from '../wsl'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from '../../renderer/src/lib/session-write-subscriber'

let state: StoreState
let mountedOptions: IpcPtyTransportOptions | undefined

vi.mock('@/store', () => ({ useAppStore: { getState: () => state, subscribe: () => () => {} } }))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/components/terminal-pane/terminal-pane-recovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestTerminalPaneRecovery: vi.fn(async () => true)
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  createIpcPtyTransport: (options: IpcPtyTransportOptions) => {
    mountedOptions = options
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (connectOptions) => {
      const { spawnIpcPty } =
        await import('../../renderer/src/components/terminal-pane/ipc-pty-spawn-request')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real connector supplies the transport connect options.
      const result = await spawnIpcPty(
        options,
        connectOptions as never,
        typeof connectOptions.sessionId === 'string' ? connectOptions.sessionId : undefined
      )
      transport.attach({ existingPtyId: result.id })
      return result
    })
    return transport
  }
}))

vi.mock('electron', () => import('./pty/pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty/pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty/pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty/pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).fsPromisesModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('mounted folder plain-shell project runtime', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()
  const platform = process.platform

  beforeEach(async () => {
    mountedOptions = undefined
    state = createInitialStoreState(() => state)
    await installTerminalTestGlobals()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })
  afterEach(async () => {
    _resetWslCachesForTests()
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    await restoreTerminalTestGlobals()
  })

  it.each([
    'plain',
    'plain-reversed',
    'acquired',
    'no-project',
    'planned',
    'planned-repair',
    'saved-host',
    'live',
    'live-repair'
  ] as const)('keeps the host-created folder %s runtime at registered startup', async (mode) => {
    const planned = mode === 'planned' || mode === 'planned-repair'
    const live = mode === 'live' || mode === 'live-repair'
    if (mode.endsWith('-repair')) {
      _setWslCachesForTests({ available: true, distros: ['Debian'] })
    }
    const folder = {
      ...MIXED_FOLDER,
      folderPath: 'C:/work/notes',
      executionHostId: 'local' as const
    }
    const repo = {
      id: 'repo1',
      path: 'C:/work/repo',
      projectGroupId: MIXED_GROUP.id,
      executionHostId: 'local' as const
    }
    const settings = {
      ...getDefaultSettings('/tmp'),
      terminalWindowsShell: 'wsl.exe',
      terminalWindowsWslDistro: 'Debian',
      localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Debian' }
    }
    const session = getDefaultWorkspaceSession()
    const worktreeId = `folder:${folder.id}`
    session.tabsByWorktree[worktreeId] = [
      makeTab({
        id: 'saved-tab',
        worktreeId,
        forceHostRuntime: mode === 'saved-host',
        startupCwd: 'C:/saved/deleted'
      })
    ]
    const getProjects = vi.fn(() => {
      if (mode === 'planned' || mode === 'live') {
        throw new Error('project temporarily unavailable')
      }
      if (mode === 'no-project') {
        return []
      }
      return [
        {
          id: 'project',
          sourceRepoIds: [repo.id],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ]
    })
    const remoteRepo = { ...repo, executionHostId: 'ssh:prod' }
    const remoteFolder = { ...folder, executionHostId: 'ssh:prod' }
    const getFolders = vi.fn(() =>
      mode === 'plain-reversed' ? [remoteFolder, folder] : [folder, remoteFolder]
    )
    const store = {
      getRepos: () => (mode === 'plain-reversed' ? [remoteRepo, repo] : [repo, remoteRepo]),
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getProjects,
      getSettings: () => settings,
      getProjectGroups: () => [MIXED_GROUP],
      getFolderWorkspaces: getFolders,
      getWorkspaceSession: () => session
    }
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    const providerSpawn = installDaemonTestProvider()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the registered runtime-controller and startup store ports exercised here.
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      () => settings,
      undefined,
      store as never
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0]
    existsSyncMock.mockClear()
    wslUncDirectoryExistsAsyncMock.mockClear()
    const savedSessionId = 'repo1::\\\\wsl.localhost\\Saved\\work@@abc12345'
    const result = await controller.spawn({
      cols: 80,
      rows: 24,
      worktreeId,
      tabId: 'saved-tab',
      ...(planned
        ? {
            launchRuntime: {
              platform: 'win32',
              pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Fedora' }
            },
            sessionId: savedSessionId
          }
        : {}),
      ...(live
        ? {
            adoptedStablePane: {
              result: { id: savedSessionId, wslDistro: 'Saved' },
              owner: {
                handle: 'handle',
                tabId: 'saved-tab',
                leafId: 'leaf',
                ptyId: savedSessionId
              },
              materialized: true
            }
          }
        : {}),
      cwd: mode === 'acquired' ? '.' : folder.folderPath,
      ...(mode === 'acquired'
        ? {
            resolvedWorkspace: {
              id: worktreeId,
              path: 'C:/retained/notes',
              connectionId: null,
              repo: null,
              folderWorkspace: { ...folder, folderPath: 'C:/retained/notes' }
            }
          }
        : {}),
      env: {}
    })
    if (live) {
      expect(result).toMatchObject({ id: savedSessionId, wslDistro: 'Saved' })
      expect(providerSpawn).not.toHaveBeenCalled()
      expect(getProjects).not.toHaveBeenCalled()
      expect(getFolders).not.toHaveBeenCalled()
      expect(existsSyncMock.mock.calls.some(([path]) => path === folder.folderPath)).toBe(false)
      expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
      expect(session.tabsByWorktree[worktreeId][0].startupCwd).toBe('C:/saved/deleted')
      return
    }
    expect(providerSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: mode === 'acquired' ? 'C:/retained/notes' : folder.folderPath,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: planned
          ? 'Saved'
          : mode === 'saved-host' || mode === 'no-project'
            ? 'Debian'
            : 'Ubuntu'
      })
    )
    if (planned || mode === 'saved-host') {
      expect(getProjects).not.toHaveBeenCalled()
    }
  })

  it('starts an actual forced-host tab before its session publication settles', async () => {
    const { connectPanePty } =
      await import('../../renderer/src/components/terminal-pane/pty-connection')
    const renderer = createTestStore()
    const folder = {
      ...MIXED_FOLDER,
      folderPath: 'C:/work/notes',
      executionHostId: 'local' as const
    }
    const repo = {
      id: 'repo1',
      path: 'C:/work/repo',
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0,
      projectGroupId: MIXED_GROUP.id,
      executionHostId: 'local' as const
    }
    const settings = {
      ...getDefaultSettings('/tmp'),
      terminalWindowsShell: 'powershell.exe',
      localWindowsRuntimeDefault: { kind: 'windows-host' as const }
    }
    const worktreeId = `folder:${folder.id}`
    renderer.setState({
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'local',
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      folderWorkspaces: [folder, { ...folder, executionHostId: 'ssh:prod' }],
      repos: [{ ...repo, executionHostId: 'ssh:prod' }, repo],
      projectGroups: [MIXED_GROUP],
      projects: [
        {
          id: 'project',
          displayName: 'Project',
          badgeColor: '#000',
          sourceRepoIds: [repo.id],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      settings
    })
    const session = getDefaultWorkspaceSession()
    let release!: () => void
    const publication = new Promise<void>((resolve) => {
      release = resolve
    })
    const persist = vi.fn(async ({ patch }: WorkspaceSessionWrite) => {
      await publication
      Object.assign(session, patch)
    })
    const dispose = createSessionWriteSubscriber({ store: renderer, persist })
    const tab = renderer
      .getState()
      .createTab(worktreeId, undefined, undefined, { forceHostRuntime: true })
    state = renderer.getState()
    const providerSpawn = installDaemonTestProvider()
    const store = {
      getRepos: () => renderer.getState().repos,
      getProjects: () => renderer.getState().projects,
      getSettings: () => settings,
      getProjectGroups: () => [MIXED_GROUP],
      getFolderWorkspaces: () => renderer.getState().folderWorkspaces,
      getWorkspaceSession: () => session,
      persistPtyBinding: vi.fn(async () => true)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the existing IPC admission, cwd and binding ports.
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      () => settings,
      undefined,
      store as never
    )
    window.api.pty.spawn = vi.fn(async (args) => handlers.get('pty:spawn')!(null, args) as never)
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(false)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    expect(session.tabsByWorktree[worktreeId]).toBeUndefined()
    const pane = createPane(1)
    const deps = buildPaneConnectionDeps(() => state, {
      worktreeId,
      tabId: tab.id,
      cwd: folder.folderPath
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane fixture implements the real connector's dependency ports.
    const binding = connectPanePty(pane as never, createManager(1) as never, deps as never)
    try {
      await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(1))
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: folder.folderPath,
          shellOverride: 'powershell.exe',
          terminalWindowsWslDistro: null
        })
      )
      expect(session.tabsByWorktree[worktreeId]).toBeUndefined()
      expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
      release()
      await vi.waitFor(() =>
        expect(session.tabsByWorktree[worktreeId]?.[0]?.forceHostRuntime).toBe(true)
      )
      await flushAsyncTicks(40)
      expect(providerSpawn).toHaveBeenCalledTimes(1)
    } finally {
      release()
      dispose()
      binding.dispose()
    }
  })

  it.each([false, true])(
    'keeps the local folder project through plain and cold startup with copied IDs (%s)',
    async (reverse) => {
      const { connectPanePty } =
        await import('../../renderer/src/components/terminal-pane/pty-connection')
      const localFolder = {
        ...MIXED_FOLDER,
        id: 'copied',
        folderPath: 'C:/work/notes',
        executionHostId: 'local' as const
      }
      const remoteFolder = { ...localFolder, executionHostId: 'ssh:prod' as const }
      const localRepo = {
        id: 'repo1',
        path: 'C:/work/repo',
        projectGroupId: MIXED_GROUP.id,
        executionHostId: 'local' as const
      }
      const remoteRepo = { ...localRepo, executionHostId: 'ssh:prod' as const }
      const settings = {
        ...getDefaultSettings('/tmp'),
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Debian' }
      }
      Object.assign(state, {
        activeWorktreeId: 'unrelated',
        repos: reverse ? [remoteRepo, localRepo] : [localRepo, remoteRepo],
        folderWorkspaces: reverse ? [remoteFolder, localFolder] : [localFolder, remoteFolder],
        projectGroups: [MIXED_GROUP],
        projects: [
          { id: 'repo1', localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }
        ],
        settings,
        unifiedTabsByWorktree: {
          'folder:copied': [
            { id: 'u', entityId: 'tab-1', contentType: 'terminal', executionHostId: 'local' }
          ]
        },
        tabsByWorktree: { 'folder:copied': [{ id: 'tab-1' }] }
      })
      const providerSpawn = installDaemonTestProvider()
      const store = {
        getRepos: () => state.repos,
        getProjectGroups: () => [MIXED_GROUP],
        getFolderWorkspaces: () =>
          reverse ? [remoteFolder, localFolder] : [localFolder, remoteFolder],
        getWorkspaceSession: getDefaultWorkspaceSession,
        persistPtyBinding: vi.fn(async () => true)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture provides the existing admission, cwd and binding store ports exercised by this spawn.
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () => settings,
        undefined,
        store as never
      )
      window.api.pty.spawn = vi.fn(async (args) => handlers.get('pty:spawn')!(null, args) as never)
      vi.mocked(window.api.pty.hasPty).mockResolvedValue(false)

      for (const mode of ['fresh', 'cold', 'force-host', 'no-project'] as const) {
        providerSpawn.mockClear()
        if (mode === 'force-host') {
          Object.assign(state.tabsByWorktree['folder:copied'][0], { forceHostRuntime: true })
        }
        if (mode === 'no-project') {
          Object.assign(state.tabsByWorktree['folder:copied'][0], { forceHostRuntime: false })
          state.projects = []
          state.repos = []
        }
        const pane = createPane(1)
        const deps = buildPaneConnectionDeps(() => state, {
          worktreeId: 'folder:copied',
          cwd: 'C:/work/notes',
          ...(mode === 'cold'
            ? {
                restoredLeafId: pane.leafId,
                restoredPtyIdByLeafId: { [pane.leafId]: 'folder:copied@@deadbeef' }
              }
            : {})
        })
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing pane/manager/dependency fixtures provide the connector contract.
        const binding = connectPanePty(pane as never, createManager(1) as never, deps as never)
        await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(1))
        await flushAsyncTicks(40)
        const expectedDistro = mode === 'fresh' || mode === 'cold' ? 'Ubuntu' : 'Debian'
        expect(providerSpawn).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: 'C:/work/notes',
            shellOverride: 'wsl.exe',
            terminalWindowsWslDistro: expectedDistro
          })
        )
        if (mode === 'cold') {
          expect(window.api.pty.spawn).toHaveBeenLastCalledWith(
            expect.objectContaining({ sessionId: 'folder:copied@@deadbeef' })
          )
        }
        expect(mountedOptions?.launchAgent).toBeUndefined()
        expect(mountedOptions?.agentLaunch).toBeUndefined()
        expect(mountedOptions?.command).toBeUndefined()
        expect(state.activeWorktreeId).toBe('unrelated')
        expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
        binding.dispose()
      }
    }
  )
})
