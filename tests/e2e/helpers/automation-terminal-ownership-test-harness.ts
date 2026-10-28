import { EventEmitter } from 'node:events'
import type * as pty from 'node-pty'
import { expect, vi } from 'vitest'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { AppState } from '../../../src/renderer/src/store/types'
import { buildProfileStateCutoverFixture } from '../../../src/main/persistence/profile-state-cutover-fixture'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  seedStore
} from '../../../src/renderer/src/store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '@/store/slices/store-session-test-harness'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import type { Store } from '../../../src/main/persistence'
import type { PtyShutdownOptions } from '../../../src/main/providers/pty-provider-contract'
import { OrcaRuntimeWithStopExactTerminalsForWorktree } from '../../../src/main/runtime/terminal/stop/worktree-terminal-stop-targets'
import { registerTerminalPresentationIpcBridge } from '@/hooks/ipc-events/terminal-presentation-ipc-bridge'
import { registerAgentLaunchTabIpcBridge } from '@/hooks/ipc-events/agent-launch-tab-ipc-bridge'
import { createDesktopRunTerminalLifecycle } from '../../../src/main/automations/desktop-run-terminal-lifecycle'
import {
  shutdownLocalPty,
  createPtyPhysicalExit
} from '../../../src/main/providers/local-pty-termination'
import {
  ptyProcesses,
  ptyIncarnations,
  ptyPhysicalExits,
  clearPtyState
} from '../../../src/main/providers/local-pty-provider-state'

export type OwnershipTestStore = UseBoundStore<StoreApi<AppState>>

export const OWNERSHIP_WORKSPACE_ID = 'repo1::/repo1/main'
const WT = OWNERSHIP_WORKSPACE_ID
const state = buildProfileStateCutoverFixture('/fixture')
const noop = () => {}
export function createAutomationTerminalOwnershipFixture(
  mocks: {
    store: OwnershipTestStore | null
    ipc: EventEmitter | null
    prepare: () => Promise<void>
  },
  cleanups: (() => void)[]
) {
  const store: OwnershipTestStore = createTestStore()
  let subscribers = 0
  const subscribe = store.subscribe
  vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
    const release = subscribe(listener)
    subscribers++
    return () => {
      subscribers--
      release()
    }
  })
  mocks.store = store
  const api = createStoreSessionMockApi()
  const listeners = new EventEmitter()
  const events: string[] = []
  const web = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      let label = channel
      if (channel === 'automations:terminalLifecycleRequest') {
        if (
          typeof payload !== 'object' ||
          payload === null ||
          !('operation' in payload) ||
          typeof payload.operation !== 'string'
        ) {
          throw new Error('Lifecycle test transport requires a string operation')
        }
        if ('phase' in payload && typeof payload.phase !== 'string') {
          throw new Error('Lifecycle test transport requires a string phase when present')
        }
        label = `${payload.operation}:${'phase' in payload ? payload.phase : ''}`
      }
      events.push(label)
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
  function bindProcess(ptyId: string, paneKey: string) {
    expectedPty = ptyId
    expectedPane = paneKey
    // SAFETY: node-pty's destructive OS boundary is a fake; exit and exact process maps are the real owner state.
    ptyProcesses.set(expectedPty, {
      pid: 4242,
      kill: () => {
        events.push('os:exit')
        ptyPhysicalExits.get(ptyId)?.markExited()
        clearPtyState(ptyId)
      }
    } as unknown as pty.IPty)
    ptyIncarnations.set(expectedPty, 'original')
    createPtyPhysicalExit(expectedPty)
  }
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
    bindProcess(expectedPty, expectedPane)
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
    bindProcess,
    activeSubscribers: () => subscribers,
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
