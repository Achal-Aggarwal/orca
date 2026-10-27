import type { PtyShutdownOptions } from '../../../main/providers/pty-provider-contract'
import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithStopExactTerminalsForWorktree } from '../../../main/runtime/terminal/stop/worktree-terminal-stop-targets'
import { AutomationService } from '../../../main/automations/service'
import {
  createStore,
  closeTestStores,
  testState,
  readPersistedStateJson
} from '../../../main/persistence/persistence-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type * as pty from 'node-pty'
import type { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import type { Store } from '../../../main/persistence'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import { buildProfileStateCutoverFixture } from '../../../main/persistence/profile-state-cutover-fixture'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  seedStore
} from '@/store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '@/store/slices/store-session-test-harness'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import {
  recordTerminalInputActivity,
  flushTerminalInputActivity
} from './terminal-input-activity-coalescing'
import { createAutomationTerminalOwnership } from './automation-terminal-ownership'
import { registerTerminalPresentationIpcBridge } from '@/hooks/ipc-events/terminal-presentation-ipc-bridge'
import { registerAgentLaunchTabIpcBridge } from '@/hooks/ipc-events/agent-launch-tab-ipc-bridge'
import {
  createDesktopRunTerminalLifecycle,
  cancelDesktopTerminalRetirement
} from '../../../main/automations/desktop-run-terminal-lifecycle'
import {
  shutdownLocalPty,
  createPtyPhysicalExit
} from '../../../main/providers/local-pty-termination'
import {
  ptyProcesses,
  ptyIncarnations,
  ptyPhysicalExits,
  ptyShutdownOperations,
  clearPtyState
} from '../../../main/providers/local-pty-provider-state'
import { isPtyDataHandlerShutdownPending } from '@/components/terminal-pane/pty-shutdown-data-suspension'
import { installPtyExitHibernate } from '@/components/terminal-pane/pty-connection/pty-exit-hibernate'
import { installSleepingRecordAccess } from '@/components/terminal-pane/pty-connection/sleeping-record-access'

const mocks = vi.hoisted(() => ({
  store: null as ReturnType<typeof createTestStore> | null,
  ipc: null as EventEmitter | null,
  capture: vi.fn(),
  prepare: async () => {}
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  mocks.ipc = new EventEmitter()
  return {
    ipcMain: mocks.ipc,
    app: { getPath: () => testState.dir },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString()
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store!.getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      mocks.store!.setState(...args),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      mocks.store!.subscribe(...args)
  }
}))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    callback: (error: unknown, output: string) => void
  ) => {
    void mocks.prepare().then(() => callback(null, '4242 1 4242 -1 Mon Jul 13 12:00:00 2026'))
  }
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

const state = buildProfileStateCutoverFixture('/fixture')
const WT = 'repo1::/repo1/main'
const noop = () => {}
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.prepare = async () => {}
  vi.spyOn(process, 'kill').mockImplementation(() => true)
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  for (const id of ptyProcesses.keys()) {
    clearPtyState(id)
  }
  flushTerminalInputActivity()
  vi.restoreAllMocks()
})

function fixture() {
  const store = createTestStore()
  mocks.store = store
  const api = createStoreSessionMockApi()
  const listeners = new EventEmitter()
  const events: string[] = []
  const web = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      events.push(
        channel === 'automations:terminalLifecycleRequest' &&
          typeof payload === 'object' &&
          payload !== null &&
          'operation' in payload
          ? `${payload.operation}:${'phase' in payload ? payload.phase : ''}`
          : channel
      )
      listeners.emit(channel, payload)
    }
  })
  const win = Object.assign(new EventEmitter(), { webContents: web, isDestroyed: () => false })
  const on = (channel: string) => (listener: (...payload: unknown[]) => void) => {
    listeners.on(channel, listener)
    return () => {
      listeners.off(channel, listener)
    }
  }
  const session = {
    set: vi.fn(async () => {
      events.push('session:set')
    }),
    flush: vi.fn(async () => {
      events.push('session:flush')
    })
  }
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: {
      ...api,
      session,
      automations: {
        onTerminalLifecycleRequest: on('automations:terminalLifecycleRequest'),
        respondTerminalLifecycle: (reply: unknown) =>
          mocks.ipc!.emit(
            'automations:terminalLifecycleResponse',
            { sender: web, senderFrame: web.mainFrame },
            reply
          )
      },
      ui: {
        onLaunchRecipe: on('recipe'),
        onCreateTerminal: on('ui:createTerminal'),
        onRequestTerminalTabMount: on('mount'),
        onPublishAgentLaunchTab: on('ui:publishAgentLaunchTab'),
        onAgentLaunchPaneVerdict: on('verdict'),
        replyAgentLaunchTabPublish: vi.fn(),
        replyTerminalCreate: vi.fn()
      }
    }
  })
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/repo1/main' })] },
    activeWorktreeId: 'other',
    activeTabId: 'other-tab',
    activeTabType: 'terminal',
    tabsByWorktree: { [WT]: [makeTab({ id: 'sibling', worktreeId: WT, ptyId: 'setup' })] },
    ptyIdsByTabId: { sibling: ['setup'] }
  })
  const unsubs: (() => void)[] = []
  registerTerminalPresentationIpcBridge(unsubs)
  registerAgentLaunchTabIpcBridge(unsubs)
  cleanups.push(() => unsubs.forEach((release) => release()))
  // SAFETY: the sibling has a fake physical process; every exercised stop owner must leave it live.
  ptyProcesses.set('setup', {
    pid: 4343,
    kill: () => {
      throw new Error('sibling stopped')
    }
  } as unknown as pty.IPty)
  ptyIncarnations.set('setup', 'setup')
  let expectedPty = ''
  let expectedPane = ''
  let provenance: string | undefined
  let stopFailure: 'live' | 'unproven' | null = null
  const runtime = {
    getAuthoritativeWindow: () => win,
    getTerminalPtyIdForHandle: () => expectedPty,
    getTerminalHandleForPaneKey: () => 'term-current',
    getPtyExecutionHostMetadata: () => ({ incarnationId: 'original', executionHostId: 'local' }),
    terminalRunFacts: { readLastDrivingInputAt: () => null },
    stopExactTerminalsForWorktree: vi.fn(
      async (
        _selector: string,
        ids: string[],
        opts: NonNullable<Parameters<OrcaRuntimeService['stopExactTerminalsForWorktree']>[2]>
      ) => {
        if (stopFailure) {
          expect(await opts.authorizeStop!()).toBe(true)
          if (stopFailure === 'unproven') {
            ptyProcesses.delete(expectedPty)
            throw new Error('lost reply')
          }
          throw new Error('still alive')
        }
        // Actual exact-stop owner proves the target exited while retaining the live sibling.
        const inventory = new Map([
          [ids[0], { worktreeId: WT, ptyId: ids[0], connected: true, incarnationId: 'original' }],
          ['setup', { worktreeId: WT, ptyId: 'setup', connected: true, incarnationId: 'setup' }]
        ])
        const exact = Object.assign(
          Object.create(OrcaRuntimeWithStopExactTerminalsForWorktree.prototype),
          {
            captureReadyGraphEpoch: noop,
            assertStableReadyGraph: noop,
            resolveWorktreeSelector: async () => ({ id: WT }),
            getResolvedWorktreeMap: async () => new Map(),
            refreshPtyWorktreeRecordsFromController: async () =>
              new Set([...ptyProcesses.keys(), 'setup']),
            leaves: new Map(),
            ptysById: inventory,
            intentionalPtyStops: { mark: () => noop },
            ptyController: {
              stopAndWait: async (id: string, options: PtyShutdownOptions) => {
                events.push('provider:prepare')
                await shutdownLocalPty(id, { ...options, immediate: true })
                events.push('provider:stopped')
                return true
              }
            }
          }
        )
        return exact.stopExactTerminalsForWorktree(_selector, ids, opts)
      }
    ),
    listTerminals: async () => ({
      terminals: [...ptyProcesses.keys()].map((ptyId) => ({
        ptyId,
        connected: true,
        incarnationId: 'original'
      }))
    })
  }
  // SAFETY: transport/window and OS doubles implement the exercised runtime/store boundaries; lifecycle and local stop are real.
  const lifecycle = createDesktopRunTerminalLifecycle(
    runtime as unknown as OrcaRuntimeService,
    {
      getWorktreeMeta: () => ({ automationProvenance: { automationRunId: provenance } }),
      listAutomationRuns: () => []
    } as unknown as Store,
    async (_id, operation) => operation()
  )
  cleanups.push(lifecycle.stop)
  function publish(
    index = 1,
    preserve = true,
    early = true,
    saved?: (typeof state.automationRuns)[number]
  ) {
    const run = {
      ...state.automationRuns[0],
      id: `run-${index}`,
      ...saved,
      workspaceId: WT,
      terminalPtyId: `pty-${index}`,
      status: 'completed' as const
    }
    provenance = preserve ? run.id : undefined
    const owner = lifecycle.begin(
      { ...state.automations[0], reuseSession: false },
      run,
      `operation-${index}`
    )!
    expectedPty = run.terminalPtyId
    expectedPane = owner.paneKey
    const [tabId, leafId] = expectedPane.split(':')
    if (early) {
      owner.reserve(WT)
    } else {
      owner.policy.onWorkspaceCreated!(WT)
    }
    if (early) {
      web.send('ui:publishAgentLaunchTab', {
        requestId: 'publish',
        worktreeId: WT,
        tabId,
        leafId,
        viewer: 'background',
        launchAgent: 'codex'
      })
    }
    // SAFETY: node-pty's destructive OS boundary is a fake; exit and exact process maps are the real owner state.
    ptyProcesses.set(expectedPty, {
      pid: 4242,
      kill: () => {
        events.push('os:exit')
        ptyPhysicalExits.get(run.terminalPtyId)?.markExited()
        clearPtyState(run.terminalPtyId)
      }
    } as unknown as pty.IPty)
    ptyIncarnations.set(expectedPty, 'original')
    createPtyPhysicalExit(expectedPty)
    owner.policy.onSurfacePublished!({
      worktreeId: WT,
      outcome: { kind: 'terminal', paneKey: expectedPane, handle: 'term-original' }
    } as never)
    store
      .getState()
      .setAgentStatus(
        expectedPane,
        { state: 'done', prompt: 'resume', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId, worktreeId: WT },
        { providerSession: { key: 'session_id', id: `session-${index}` } }
      )
    return { run, owner, tabId, leafId, paneKey: expectedPane }
  }
  return {
    store,
    session,
    runtime,
    lifecycle,
    publish,
    events,
    web,
    listeners,
    prepare: (fn: () => Promise<void>) => {
      mocks.prepare = fn
    },
    failStop: (kind: typeof stopFailure) => {
      stopFailure = kind
    }
  }
}

describe('desktop completion through local publication and process owner', () => {
  it('composes durable service completion with publication, exact stop and local sleep', async () => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-34332-composition-'))
    const disk = await createStore()
    try {
      disk.addRepo({ ...state.repos[0], id: 'r1', path: '/fixture' })
      const automation = disk.createAutomation({
        name: 'Composition',
        prompt: 'check',
        agentId: 'codex',
        projectId: 'r1',
        workspaceMode: 'existing',
        workspaceId: WT,
        timezone: 'UTC',
        rrule: 'FREQ=DAILY',
        dtstart: 1
      })
      const saved = disk.createAutomationRun(automation, Date.now(), 'manual')
      const f = fixture()
      const t = f.publish(1, true, true, saved)
      const phases: string[] = []
      const service = new AutomationService(disk, {
        onRunFinalized: async (run) => {
          phases.push('finalize')
          expect(disk.listAutomationRuns()[0]).toMatchObject({
            id: saved.id,
            status: 'completed',
            terminalPtyId: t.run.terminalPtyId
          })
          const persisted = JSON.parse(
            readPersistedStateJson(join(testState.dir, 'orca-data.json'))
          )
          expect(JSON.stringify(persisted)).toContain('completed')
          return f.lifecycle.finalize(run)
        },
        codexUsage: {
          getAutomationRunUsage: async () => {
            phases.push('usage')
            expect(disk.listAutomationRuns()[0].terminalPtyId).toBeNull()
            return null
          }
        } as never
      })
      expect(
        await service.markDispatchResult({
          runId: saved.id,
          status: 'completed',
          workspaceId: WT,
          terminalPtyId: t.run.terminalPtyId,
          terminalPaneKey: t.paneKey,
          terminalSessionId: t.tabId
        })
      ).toMatchObject({ terminalPtyId: null, terminalPaneKey: t.paneKey, status: 'completed' })
      expect(f.store.getState().sleepingAgentSessionsByPaneKey[t.paneKey].origin).toBe(
        'worktree-sleep'
      )
      expect([...ptyProcesses.keys()]).toEqual(['setup'])
      expect(phases).toEqual(['finalize', 'usage'])
      service.stop()
    } finally {
      await closeTestStores()
      rmSync(testState.dir, { recursive: true, force: true })
    }
  })
  it.each([true, false])(
    'retires only an untouched original, early publication=%s',
    async (early) => {
      const f = fixture()
      const target = f.publish(1, true, early)
      const patch = await f.lifecycle.finalize(target.run)
      expect(patch).toMatchObject({ terminalPtyId: null })
      expect(f.events.indexOf('arm:')).toBeLessThan(
        f.events.indexOf(early ? 'ui:publishAgentLaunchTab' : 'ui:createTerminal')
      )
      expect(f.events.indexOf('session:flush')).toBeLessThan(f.events.indexOf('os:exit'))
      expect(f.store.getState().ptyIdsByTabId[target.tabId]).toEqual([])
      expect(f.store.getState().ptyIdsByTabId.sibling).toEqual(['setup'])
      expect(f.store.getState().sleepingAgentSessionsByPaneKey[target.paneKey]).toMatchObject({
        origin: 'worktree-sleep',
        providerSession: { id: 'session-1' }
      })
      expect(f.store.getState().activeWorktreeId).toBe('other')
      expect(f.web.eventNames()).toEqual([])
      expect(mocks.ipc!.eventNames()).toEqual([])
      expect(ptyShutdownOperations.size).toBe(0)
      expect(isPtyDataHandlerShutdownPending(target.run.terminalPtyId)).toBe(false)
    }
  )
  it.each([false, true])(
    'ordinary wake consumes the captured pane once, reveal racing exit=%s',
    async (racing) => {
      const f = fixture()
      const t = f.publish()
      await f.lifecycle.finalize(t.run)
      const visible = { current: racing }
      let currentPty: string | null = t.run.terminalPtyId
      const transport = { getPtyId: () => currentPty }
      // SAFETY: pane rendering and physical resume are the boundaries; actual ordinary exit/sleep-record/wake owners execute.
      const session = {
        pane: { id: 1, leafId: t.leafId },
        paneStartup: {},
        cacheKey: t.paneKey,
        disposed: false,
        runtimeEnvironmentId: null,
        transport,
        manager: { setPaneGpuRendering: noop, getActivePane: () => null },
        deps: {
          tabId: t.tabId,
          worktreeId: WT,
          isVisibleRef: visible,
          paneTransportsRef: { current: new Map([[1, transport]]) },
          isPtyShutdownPending: isPtyDataHandlerShutdownPending,
          consumeSuppressedPtyExit: (id: string) => f.store.getState().consumeSuppressedPtyExit(id),
          clearTabPtyId: (tab: string, id: string) => f.store.getState().clearTabPtyId(tab, id),
          clearRuntimePaneTitle: noop,
          setCacheTimerStartedAt: noop
        },
        resetRendererOrderedSeqForPtyExit: noop,
        agentCompletionCoordinator: { dispose: noop },
        dropSideEffectFactConsumer: noop,
        releaseHiddenRendererPtyDelivery: noop,
        clearPanePtyFitBinding: noop,
        clearExitedPanePtyLayoutBinding: noop,
        writeInputModeGround: noop
      } as unknown as ConnectPanePtySession
      installSleepingRecordAccess(session)
      installPtyExitHibernate(session)
      const resume = vi.fn(async () => {
        const record = session.getSleepingRecordForPane(f.store.getState())
        expect(record.record.providerSession.id).toBe('session-1')
        session.clearSleepingRecordProviderDuplicates(f.store.getState(), record)
        currentPty = 'resumed'
        f.store.getState().updateTabPtyId(t.tabId, currentPty)
        return currentPty
      })
      session.wakeHibernatedAgentPane = resume
      // A persisted pre-stop record with a live binding does not itself cause another spawn.
      expect(resume).not.toHaveBeenCalled()
      session.onExit(t.run.terminalPtyId, 0)
      await Promise.resolve()
      if (!racing) {
        expect(resume).not.toHaveBeenCalled()
        visible.current = true
        session.consumeHibernatedAgentWake()
      }
      await Promise.resolve()
      expect(resume).toHaveBeenCalledOnce()
      session.consumeHibernatedAgentWake()
      expect(resume).toHaveBeenCalledOnce()
      expect(f.store.getState().sleepingAgentSessionsByPaneKey[t.paneKey]).toBeUndefined()
      expect(f.store.getState().ptyIdsByTabId.sibling).toEqual(['setup'])
    }
  )
  it.each(['prepare-persist', 'commit-persist'] as const)(
    'keeps recovery truthful on %s failure',
    async (point) => {
      const f = fixture()
      const t = f.publish()
      if (point === 'prepare-persist') {
        f.session.flush.mockRejectedValueOnce(new Error('disk unavailable'))
      }
      if (point === 'commit-persist') {
        f.session.flush
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('commit unavailable'))
      }
      const patch = await f.lifecycle.finalize(t.run)
      if (point === 'prepare-persist') {
        expect(patch).toBeNull()
        expect(f.events).not.toContain('os:exit')
      } else {
        expect(patch).toMatchObject({ terminalPtyId: null })
        expect(f.store.getState().sleepingAgentSessionsByPaneKey[t.paneKey]).toBeDefined()
      }
      expect(f.store.getState().tabsByWorktree[WT].some((tab) => tab.id === t.tabId)).toBe(true)
    }
  )
  it('closes a shared-workspace tab only after exact physical stop', async () => {
    const f = fixture()
    const t = f.publish(1, false)
    f.prepare(async () =>
      expect(f.store.getState().tabsByWorktree[WT].some((tab) => tab.id === t.tabId)).toBe(true)
    )
    expect(await f.lifecycle.finalize(t.run)).toMatchObject({
      terminalPtyId: null,
      terminalPaneKey: null,
      terminalSessionId: null
    })
    expect(f.store.getState().tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['sibling'])
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })
  it.each([
    'view',
    'pending-input',
    'replacement',
    'process',
    'new-record',
    'recreate',
    'move',
    'split',
    'reload',
    'ordinary-stop'
  ] as const)('keeps the original on %s during preparation', async (reason) => {
    const f = fixture()
    const t = f.publish()
    f.prepare(async () => {
      const s = f.store.getState()
      if (reason === 'view') {
        f.store.setState({ activeWorktreeId: WT, activeTabId: t.tabId, activeTabType: 'terminal' })
        f.store.setState({ activeWorktreeId: 'other', activeTabId: 'other-tab' })
      } else if (reason === 'pending-input') {
        const commit = { insert: () => {}, refreshExisting: () => {} }
        f.store.setState({ lastTerminalInputAtByPaneKey: { [t.paneKey]: 100 } })
        recordTerminalInputActivity({ paneKey: t.paneKey, timestamp: 100, commit })
        recordTerminalInputActivity({ paneKey: t.paneKey, timestamp: 101, commit })
      } else if (reason === 'replacement') {
        s.updateTabPtyId(t.tabId, 'replacement')
      } else if (reason === 'process') {
        ptyIncarnations.set(t.run.terminalPtyId, 'replacement')
      } else if (reason === 'new-record') {
        f.store.setState({
          sleepingAgentSessionsByPaneKey: {
            [t.paneKey]: { ...s.sleepingAgentSessionsByPaneKey[t.paneKey], origin: 'live' }
          }
        })
      } else if (reason === 'recreate') {
        const original = s.tabsByWorktree[WT].find((tab) => tab.id === t.tabId)!
        f.store.setState({
          tabsByWorktree: { [WT]: s.tabsByWorktree[WT].filter((tab) => tab.id !== t.tabId) }
        })
        f.store.setState({ tabsByWorktree: { [WT]: [...s.tabsByWorktree[WT]] } })
        expect(original.createdAt).toBeDefined()
      } else if (reason === 'move') {
        f.store.setState({ tabsByWorktree: { [WT]: [], elsewhere: s.tabsByWorktree[WT] } })
      } else if (reason === 'split') {
        s.setTabLayout(t.tabId, {
          ...singlePaneLayoutSnapshot(t.leafId, t.run.terminalPtyId),
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: t.leafId },
            second: { type: 'leaf', leafId: 'second' }
          }
        })
      } else if (reason === 'reload') {
        f.web.emit('did-start-navigation', {}, 'reload', false, true)
      } else {
        cancelDesktopTerminalRetirement(t.run.terminalPtyId)
      }
    })
    expect(await f.lifecycle.finalize(t.run)).toBeNull()
    expect(f.events).not.toContain('os:exit')
    expect(ptyProcesses.has(t.run.terminalPtyId)).toBe(true)
    expect(isPtyDataHandlerShutdownPending(t.run.terminalPtyId)).toBe(false)
  })
  it.each(['live', 'unproven'] as const)(
    'preserves truthful recovery after a %s stop failure',
    async (proof) => {
      const f = fixture()
      const t = f.publish()
      f.failStop(proof)
      expect(await f.lifecycle.finalize(t.run)).toBeNull()
      expect(f.store.getState().tabsByWorktree[WT].some((tab) => tab.id === t.tabId)).toBe(true)
      expect(f.store.getState().sleepingAgentSessionsByPaneKey[t.paneKey]?.origin).toBe(
        proof === 'live' ? 'live' : 'worktree-sleep'
      )
      expect(isPtyDataHandlerShutdownPending(t.run.terminalPtyId)).toBe(false)
    }
  )
  it.each(['view', 'input'] as const)(
    'retains synchronous %s takeover before prompt settlement',
    async (kind) => {
      const f = fixture()
      const t = f.publish()
      if (kind === 'view') {
        f.store.setState({ activeWorktreeId: WT, activeTabId: t.tabId, activeTabType: 'terminal' })
        f.store.setState({ activeWorktreeId: 'other', activeTabId: 'other-tab' })
      } else {
        recordTerminalInputActivity({
          paneKey: t.paneKey,
          timestamp: Date.now(),
          commit: {
            insert: (key, stamp) =>
              f.store.setState({ lastTerminalInputAtByPaneKey: { [key]: stamp } }),
            refreshExisting: noop
          }
        })
      }
      expect(await f.lifecycle.finalize(t.run)).toBeNull()
      expect(f.events).not.toContain('os:exit')
      expect(ptyProcesses.has(t.run.terminalPtyId)).toBe(true)
    }
  )
  it.each(['generation', 'frame-loss'] as const)(
    'releases unknown eligibility after %s and ignores a late reply',
    async (reason) => {
      const f = fixture()
      const respond = window.api.automations.respondTerminalLifecycle
      let late: Parameters<typeof respond>[0] | undefined
      window.api.automations.respondTerminalLifecycle = (reply) => {
        if (reply.operation !== 'arm') {
          return respond(reply)
        }
        late = reply
        if (reason === 'generation') {
          respond({ ...reply, serviceGeneration: 'different-service' })
        } else {
          mocks.ipc!.emit(
            'automations:terminalLifecycleResponse',
            { sender: f.web, senderFrame: {} },
            reply
          )
        }
      }
      const t = f.publish()
      if (reason === 'frame-loss') {
        f.web.emit('render-process-gone')
      }
      expect(await f.lifecycle.finalize(t.run)).toBeNull()
      if (late) {
        respond(late)
      }
      expect(f.events).not.toContain('os:exit')
      expect(mocks.ipc!.eventNames()).toEqual([])
      expect(f.web.eventNames()).toEqual([])
      expect(ptyProcesses.has(t.run.terminalPtyId)).toBe(true)
    }
  )
  it('never enrolls an already materialized or restarted surface as untouched', () => {
    const f = fixture()
    const t = f.publish()
    const owner = createAutomationTerminalOwnership(f.store, { worktreeId: WT, ...t })
    expect(owner.bind(t.run.terminalPtyId)).toBe(false)
    owner.release()
    expect(
      f.lifecycle.begin({ ...state.automations[0], reuseSession: true }, t.run, 'reuse')
    ).toBeNull()
  })
  it.each([5, 50])('bounds repeated cleanup resources at N=%i', async (count) => {
    const f = fixture()
    for (let n = 1; n <= count; n++) {
      const t = f.publish(n, n % 2 === 0, n % 3 === 0)
      expect(await f.lifecycle.finalize(t.run)).toMatchObject({ terminalPtyId: null })
      expect([...ptyProcesses.keys()]).toEqual(['setup'])
      expect(f.web.eventNames()).toEqual([])
      expect(mocks.ipc!.eventNames()).toEqual([])
      expect(isPtyDataHandlerShutdownPending(t.run.terminalPtyId)).toBe(false)
    }
    expect(f.store.getState().tabsByWorktree[WT]).toHaveLength(1 + Math.floor(count / 2))
    expect(
      Object.values(f.store.getState().sleepingAgentSessionsByPaneKey).filter(
        (r) => r.origin === 'worktree-sleep'
      )
    ).toHaveLength(Math.floor(count / 2))
    console.info(
      JSON.stringify({
        desktopRuns: count,
        livePtys: ptyProcesses.size,
        shutdowns: ptyShutdownOperations.size,
        relayListeners: mocks.ipc!.eventNames().length
      })
    )
  })
})
