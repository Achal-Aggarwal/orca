import {
  measureTerminalInventory,
  assertTerminalInventorySelection
} from './helpers/automation-terminal-inventory-test-harness'
import * as desktopLifecycle from '../../src/main/automations/desktop-run-terminal-lifecycle'
import { randomUUID } from 'node:crypto'
import { createRuntimeAutomationService } from '../../src/main/automations/runtime-automation-service'
import { runtimeStub } from '../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import { createQueuedMessageTestRig } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { hostTestAttachParams } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { readAutomationRunReceipt } from '../../src/main/automations/automation-run-receipt'
import { hostWorktreeTarget } from '../../src/shared/worktree/host-qualified-identity'
import { revealCreatedTerminal } from '../../src/main/runtime/terminal/launch/terminal-create-reveal'
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from '../../src/main/runtime/session-tabs/pty-backed-session-publication'
import { OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce } from '../../src/main/runtime/session-tabs/structured-session-tab-restoration'
import type { RuntimeMobileSessionTabsSnapshot } from '../../src/shared/runtime-types'
import {
  stopRevokers,
  cancelDesktopTerminalRetirement
} from '../../src/main/automations/desktop-run-terminal-stop'
import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AutomationService } from '../../src/main/automations/service'
import {
  createStore,
  closeTestStores,
  testState,
  readPersistedStateJson,
  writeDataFile
} from '../../src/main/persistence/persistence-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import { buildProfileStateCutoverFixture } from '../../src/main/persistence/profile-state-cutover-fixture'
import type { OwnershipTestStore } from './helpers/automation-terminal-ownership-test-harness'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import {
  recordTerminalInputActivity,
  flushTerminalInputActivity
} from '../../src/renderer/src/lib/terminal-input-activity-coalescing'
import { createAutomationTerminalOwnership } from '../../src/renderer/src/lib/automation-terminal-ownership'
import {
  ptyProcesses,
  ptyIncarnations,
  ptyShutdownOperations,
  clearPtyState
} from '../../src/main/providers/local-pty-provider-state'
import { isPtyDataHandlerShutdownPending } from '@/components/terminal-pane/pty-shutdown-data-suspension'
import { installPtyExitHibernate } from '@/components/terminal-pane/pty-connection/pty-exit-hibernate'
import { installSleepingRecordAccess } from '@/components/terminal-pane/pty-connection/sleeping-record-access'

const mocks = vi.hoisted(
  (): {
    store: OwnershipTestStore | null
    ipc: EventEmitter | null
    capture: Mock
    prepare: () => Promise<void>
  } => ({
    store: null,
    ipc: null,
    capture: vi.fn(),
    prepare: async () => {}
  })
)
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
    setState: (...args: Parameters<OwnershipTestStore['setState']>) =>
      mocks.store!.setState(...args),
    subscribe: (...args: Parameters<OwnershipTestStore['subscribe']>) =>
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
import {
  createAutomationTerminalOwnershipFixture,
  OWNERSHIP_WORKSPACE_ID as WT
} from './helpers/automation-terminal-ownership-test-harness'
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
  return createAutomationTerminalOwnershipFixture(mocks, cleanups)
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
        if (reply.disposition !== 'armed') {
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
})

it.each([5, 50])('bounds actual desktop fallback/Chat/Reuse owners at N=%i', async (count) => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  const root = mkdtempSync(join(tmpdir(), 'orca-34332-fallback-'))
  testState.dir = root
  const disk = createStore(),
    f = fixture()
  const rig = await createQueuedMessageTestRig({ restartable: true })
  setStructuredAgentSessionHost(rig.host)
  const timers = vi.spyOn(globalThis, 'setTimeout'),
    cleared = vi.spyOn(globalThis, 'clearTimeout')
  const tabs = new Map<string, RuntimeMobileSessionTabsSnapshot>()
  const bindings = new Map<string, { paneKey: string; ptyId: string }>()
  const publisher = Object.assign(
    Object.create(OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal.prototype),
    {
      mobileSessionTabsByWorktree: tabs,
      isMobileSessionSurfaceMembershipAllowed: () => true,
      getPtyDisplayRecord: (record: unknown) => record,
      getPtyManualTitle: () => null,
      storeMobileSessionSnapshot: (id: string, snapshot: RuntimeMobileSessionTabsSnapshot) => {
        tabs.set(id, snapshot)
        return snapshot
      },
      notifyMobileSessionTabsChanged: vi.fn()
    }
  )
  const chatPublisher = Object.assign(
    Object.create(OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce.prototype),
    {
      mobileSessionTabsByWorktree: tabs,
      saveWindowlessAgentSessionTab: vi.fn(),
      storeMobileSessionSnapshot: publisher.storeMobileSessionSnapshot,
      emitMobileSessionTabsSnapshot: vi.fn()
    }
  )
  let mode = 'unavailable',
    currentRun = '',
    service: ReturnType<typeof createRuntimeAutomationService> | undefined
  const trace: string[] = []
  const runtime = {
    ...runtimeStub(),
    ...f.runtime,
    requireStore: () => disk,
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    openAgentSessionRecordStore: async () => rig.store,
    showRepo: async () => disk.getRepo('repo1'),
    showAutomation: (id: string) => disk.listAutomations().find((a) => a.id === id),
    listAutomationRuns: (id: string) => disk.listAutomationRuns(id),
    getAgentStatusRowsForPane: () => [],
    getTerminalPtyIdForHandle: (handle: string) => bindings.get(handle)?.ptyId ?? null,
    getTerminalPaneKey: (handle: string) => bindings.get(handle)?.paneKey ?? null,
    getTerminalHandleForPaneKey: (paneKey: string) =>
      [...bindings].find(([, b]) => b.paneKey === paneKey && ptyProcesses.has(b.ptyId))?.[0] ??
      null,
    showManagedWorktree: async () => ({ displayName: 'Fallback' }),
    getStructuredAgentSessionCreateSupport: async () => {
      trace.push('support')
      if (mode === 'unknown') {
        throw new Error('support unavailable')
      }
      return { supported: mode === 'refused' || mode === 'chat', reason: 'chat-program' as const }
    },
    resolveStructuredAgentSessionCreateIntent: async () => {
      if (mode === 'refused') {
        throw new Error('structured_agent_session_unsupported')
      }
      const { envelope: _, ...params } = hostTestAttachParams(null)
      return { ...params, location: { ...params.location, workspaceId: WT } }
    },
    publishStructuredAgentSessionTab:
      chatPublisher.publishStructuredAgentSessionTab.bind(chatPublisher),
    createManagedWorktree: async (
      args: Parameters<OrcaRuntimeService['createManagedWorktree']>[0]
    ) => {
      trace.push('create')
      currentRun = args.automationProvenance!.automationRunId
      disk.setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'local' }), {
        automationProvenance: args.automationProvenance
      })
      args.onWorkspaceCreated!(WT)
      return { worktree: { id: WT, path: '/repo1/main' } }
    },
    createTerminal: async (
      _selector: string,
      options: NonNullable<Parameters<OrcaRuntimeService['createTerminal']>[1]>
    ) => {
      trace.push('terminal')
      const tabId = options.tabId ?? randomUUID(),
        leafId = options.leafId ?? randomUUID()
      const paneKey = `${tabId}:${leafId}`
      const ptyId = `actual-${bindings.size}`,
        handle = `term-${bindings.size}`
      bindings.set(handle, { paneKey, ptyId })
      f.bindProcess(ptyId, paneKey)
      publisher.publishPtyBackedMobileSessionTerminal(
        WT,
        { ptyId, incarnationId: 'original', launchAgent: 'codex' },
        { tabId, leafId, title: 'Codex', activate: false, selectIfNoActiveTab: false }
      )
      await revealCreatedTerminal({
        notifier: null,
        workspace: { id: WT, path: '/repo1/main' },
        ptyId,
        handle,
        cwd: '/repo1/main',
        launchOpts: options,
        opts: options,
        tabId,
        leafId,
        presentation: options.presentation,
        adoptedStablePane: false,
        effectiveLaunchConfig: undefined,
        launchToken: undefined
      })
      options.onPtySpawnDispatched?.()
      options.onStartupPromptCarry?.(true)
      return { handle, paneKey }
    },
    deliverStartupFollowup: async () => true,
    waitForTerminal: async (_handle: string, options: { signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        if (options.signal.aborted) {
          reject(new Error('aborted'))
        } else {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        }
      }),
    readTerminal: async () => ({ tail: [] })
  }
  try {
    disk.addRepo({ ...state.repos[0], id: 'repo1', path: '/repo1/main', connectionId: null })
    // SAFETY: only runtime OS/transport boundaries are scripted; service, common executor, receipt, lifecycle, renderer transaction and stop owner are real.
    service = createRuntimeAutomationService({
      store: disk,
      runtime: runtime as unknown as OrcaRuntimeService,
      headless: false,
      createDesktopLifecycle: desktopLifecycle.createDesktopRunTerminalLifecycle
    })
    service.setWebContents(f.web)
    service.setRendererReady()
    let eligible = 0,
      retained = 0,
      chats = 0
    for (let n = 0; n < count; n++) {
      mode = ['unavailable', 'unknown', 'refused', 'chat', 'unavailable'][n % 5]
      const reuseSession = n % 5 === 4
      const automation = disk.createAutomation({
        name: 'Fallback',
        prompt: 'check',
        agentId: 'codex',
        projectId: 'repo1',
        workspaceMode: reuseSession ? 'existing' : 'new_per_run',
        workspaceId: reuseSession ? WT : null,
        launchSetupPatch: { surface: reuseSession ? 'terminal' : 'chat' },
        reuseSession,
        timezone: 'UTC',
        rrule: 'FREQ=DAILY',
        dtstart: Date.now() + 86400000,
        setupDecision: 'skip'
      })
      expect(automation.surface).toBe(reuseSession ? 'terminal' : 'chat')
      const start = f.events.length
      const run = await service.runNow(automation.id)
      expect(run.status).toBe('dispatched')
      expect(readAutomationRunReceipt(rig.store, run)?.accepted).toBe(true)
      expect(trace.splice(0)).toEqual(
        reuseSession
          ? ['terminal']
          : mode === 'chat'
            ? ['create', 'support']
            : ['create', 'support', 'terminal']
      )
      if (mode === 'chat') {
        chats++
        expect(run.sessionKind).toBe('chat')
        expect(f.events.slice(start)).toContain('arm:')
        expect(f.events.slice(start)).not.toContain('ui:createTerminal')
        expect(tabs.get(WT)!.tabs.filter((t) => t.type === 'agent-session')).toHaveLength(chats)
        expect(chatPublisher.saveWindowlessAgentSessionTab.mock.lastCall[1].activate).toBe(false)
      } else if (reuseSession) {
        retained++
        expect(f.events.slice(start).some((e) => e.startsWith('arm:'))).toBe(false)
      } else {
        eligible++
        expect(f.events.slice(start).filter((e) => e.startsWith('arm:'))).toHaveLength(1)
        expect(f.events.slice(start).filter((e) => e.startsWith('bind:'))).toHaveLength(1)
        expect(f.events.indexOf('arm:', start)).toBeLessThan(
          f.events.indexOf('ui:createTerminal', start)
        )
        f.store
          .getState()
          .setAgentStatus(
            run.terminalPaneKey!,
            { state: 'done', prompt: 'resume', agentType: 'codex' },
            'Codex',
            { updatedAt: 2000, stateStartedAt: 1000 },
            { tabId: run.terminalSessionId!, worktreeId: WT },
            { providerSession: { key: 'session_id', id: currentRun } }
          )
      }
      const finalized = await service.markDispatchResult({ runId: run.id, status: 'completed' })
      expect(finalized.terminalPtyId).toBe(reuseSession ? run.terminalPtyId : null)
      expect(stopRevokers.size).toBe(0)
      expect(f.activeSubscribers()).toBe(0)
      expect(ptyShutdownOperations.size).toBe(0)
      expect(f.web.eventNames()).toEqual([])
      expect(mocks.ipc!.eventNames()).toEqual([])
      expect(ptyProcesses.size).toBe(1 + retained)
      expect(ptyProcesses.has('setup')).toBe(true)
      const persisted = JSON.parse(readPersistedStateJson(join(root, 'orca-data.json')))
      expect(
        persisted.automationRuns.find((row: { id: string }) => row.id === run.id)
      ).toMatchObject({
        status: 'completed',
        chatSessionId: run.chatSessionId,
        terminalPtyId: finalized.terminalPtyId
      })
    }
    const sessions = rig.host.collaboratorsForTests().sessions
    expect(sessions['observers'].size).toBe(0)
    expect(sessions['attachments'].size).toBe(chats + 1)
    const protocol = timers.mock.calls.flatMap((args, i) =>
      args[1] === 20_000 ? [timers.mock.results[i].value] : []
    )
    for (const timer of protocol) {
      expect(cleared).toHaveBeenCalledWith(timer)
    }
    const sleepers = Object.keys(f.store.getState().sleepingAgentSessionsByPaneKey).length
    expect(sleepers).toBe(eligible)
    expect(f.store.getState().tabsByWorktree[WT]).toHaveLength(1 + eligible)
    process.stdout.write(
      `${JSON.stringify({ desktopRuns: count, canonicalSources: sessions['attachments'].size, logicalObservers: sessions['observers'].size, eligible, retainedReuse: retained, chats, ptys: ptyProcesses.size, desktopTabs: f.store.getState().tabsByWorktree[WT].length, runtimeTabs: tabs.get(WT)!.tabs.length, sleepers, registrations: stopRevokers.size, subscribers: f.activeSubscribers(), timersCreated: protocol.length, timersCleared: protocol.filter((timer) => cleared.mock.calls.some(([clearedTimer]) => timer === clearedTimer)).length })}\n`
    )
  } finally {
    service?.stop()
    setStructuredAgentSessionHost(null)
    await rig.dispose()
    await closeTestStores()
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([
  [5, 100],
  [50, 1000]
])('shares one current inventory for %i owners and %i retained rows', async (owners, history) => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-34332-inventory-'))
  const seeded = buildProfileStateCutoverFixture('/fixture')
  seeded.automations = Array.from({ length: history / 100 }, (_, i) => ({
    ...seeded.automations[0],
    id: `inventory-${i}`
  }))
  seeded.automationRuns = Array.from({ length: history }, (_, i) => ({
    ...seeded.automationRuns[0],
    id: `inventory-run-${i}`,
    automationId: seeded.automations[Math.floor(i / 100)].id,
    status: i < owners ? (['dispatching', 'dispatched', 'completed'] as const)[i % 3] : 'completed',
    createdAt: i
  }))
  writeDataFile(seeded)
  const disk = createStore(),
    f = fixture()
  const create = vi.spyOn(desktopLifecycle, 'createDesktopRunTerminalLifecycle')
  const runtime = {
    ...runtimeStub(),
    ...f.runtime,
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn()
  }
  // SAFETY: only the OS/window transport is scripted; actual runtime/service/writer/persistence/lifecycle owners execute.
  const service = createRuntimeAutomationService({
    store: disk,
    runtime: runtime as unknown as OrcaRuntimeService,
    headless: false,
    createDesktopLifecycle: desktopLifecycle.createDesktopRunTerminalLifecycle
  })
  const lifecycle = create.mock.results[0].value!
  try {
    const runs = disk.listAutomationRuns(),
      registered = new Set(
        runs.filter((r) => Number(r.id.split('-').at(-1)) < owners).map((r) => r.id)
      )
    await service.markDispatchResult({ runId: runs[0].id, status: 'completed' })
    const inventory = measureTerminalInventory(disk, lifecycle, registered)
    const { lists } = inventory
    lifecycle.reconcile()
    expect(lists).not.toHaveBeenCalled()
    for (const run of runs.filter((r) => registered.has(r.id))) {
      expect(
        lifecycle.begin({ ...seeded.automations[0], reuseSession: false }, run, run.id)
      ).not.toBeNull()
    }
    await service.markDispatchResult({
      runId: runs[0].id,
      status: 'completed'
    })
    expect(inventory.counts()).toEqual({
      inventories: 1,
      normalizations: history,
      sorts: 1,
      rows: history,
      statusVisits: history,
      linearFinds: 0,
      selectedLookups: owners
    })
    expect(f.web.listenerCount('render-process-gone')).toBe(1)
    process.stdout.write(`${JSON.stringify({ owners, history, ...inventory.counts() })}\n`)
    lifecycle.begin(
      { ...seeded.automations[0], reuseSession: false },
      { ...runs[0], id: 'missing' },
      'missing'
    )
    lifecycle.reconcile()
    expect(stopRevokers.size).toBe(owners)
    const failed = runs.find((run) => registered.has(run.id))!
    await service.markDispatchResult({ runId: failed.id, status: 'dispatch_failed' })
    expect(stopRevokers.size).toBe(owners - 1)
    lifecycle.stop()
    lists.mockClear()
    lifecycle.reconcile()
    expect(lists).not.toHaveBeenCalled()
    assertTerminalInventorySelection(runs[0])
    expect(f.web.eventNames()).toEqual([])
  } finally {
    service.stop()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  }
})
