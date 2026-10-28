import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createPane } from '../pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../pty-connection-test-environment'
import { createReattachPayloadHandlers } from './apply-reattach-payload'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { mainStartsPane } from './main-starts-pane'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindDeferredColdRestoreAndSnapshot } from './deferred-cold-restore-and-snapshot'
import { bindHandleReattachResult } from './reattach-result-handler'
import { pendingSpawnByPaneKey } from './pty-connect-limits'
import { flushAsyncTicks } from '../pty-connection-test-async'

function createSession(overrides: Record<string, unknown> = {}): ConnectPanePtySession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test read only these session members.
  return {
    pane: createPane(1),
    deps: { worktreeId: 'wt-1', tabId: 'tab-1' },
    rememberReattachPayloadAgentSignal: vi.fn(),
    writeReplayData: vi.fn(),
    writeInputModeGround: vi.fn(),
    chooseReattachReplayReset: vi.fn(() => '<reset>'),
    writeReplayEpilogue: vi.fn(),
    sendFocusedReattachFocusInAfterReplay: vi.fn(),
    kittyKeyboardModes: {
      hasProvenBaseline: true,
      reset: vi.fn(),
      resetForSnapshot: vi.fn(),
      scanReplay: vi.fn(),
      adoptSnapshot: vi.fn()
    },
    ...overrides
  } as unknown as ConnectPanePtySession
}

function createContext(replay: string, attemptGeneration: number): ReattachPayloadContext {
  return {
    isCurrentReattachPayload: () => true,
    connectResult: { id: 'pty-1', replay },
    ptyId: 'pty-1',
    attemptGeneration,
    prefetchedParkModelSnapshot: null,
    revealFollowsTerminalPark: false,
    shouldApplyStructuralPayload: true,
    coldRestoreStartup: undefined,
    reattachPayloadApplied: false,
    skippedAltFrameCaptureCols: null
  }
}

describe('reattach payload context', () => {
  beforeEach(async () => {
    await installTerminalTestGlobals()
  })

  afterEach(async () => restoreTerminalTestGlobals())

  it('keeps overlapping payload handlers bound to their own attempt', async () => {
    const session = createSession()
    const attemptA = createReattachPayloadHandlers(session, createContext('PAYLOAD-A', 1))
    const attemptB = createReattachPayloadHandlers(session, createContext('PAYLOAD-B', 2))

    await attemptB.applyReattachPayload()
    await attemptA.applyReattachPayload()

    expect(session.rememberReattachPayloadAgentSignal.mock.calls).toEqual([
      ['PAYLOAD-B', { fullScreenReplay: true }],
      ['PAYLOAD-A', { fullScreenReplay: true }]
    ])
    expect(session.sendFocusedReattachFocusInAfterReplay.mock.calls).toEqual([
      ['pty-1', 2],
      ['pty-1', 1]
    ])
  })

  it('uses the connect startup plan without rebuilding or scheduling paste delivery', async () => {
    const startup = {
      command: 'codex resume provider-session',
      agent: 'codex',
      resumeProviderSession: { key: 'session_id', id: 'provider-session' },
      launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
      launchToken: 'transport-launch-token',
      useLiveEntry: false,
      hasSleepingRecord: false,
      sleepingRecordEntry: null
    } as ColdRestoreAgentResumeStartup
    const buildColdRestoreAgentResumeStartup = vi.fn()
    const applyColdRestoreAgentResumeStartup = vi.fn((value) => Boolean(value))
    const schedulePendingStartupCommandDelivery = vi.fn()
    const session = createSession({
      buildColdRestoreAgentResumeStartup,
      applyColdRestoreAgentResumeStartup,
      schedulePendingStartupCommandDelivery,
      showSessionRestoredBanner: vi.fn(),
      clearSleepingRecordAfterColdRestoreSpawn: vi.fn(),
      consumeRestoredViewportBlankingMarker: vi.fn(),
      writeFreshShellViewportBlanking: vi.fn()
    })
    const context: ReattachPayloadContext = {
      ...createContext('', 1),
      connectResult: {
        id: 'pty-1',
        coldRestore: { scrollback: 'restored scrollback', cwd: '/workspace' }
      },
      coldRestoreStartup: startup
    }

    await createReattachPayloadHandlers(session, context).applyReattachPayload()

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main started the pane and resumed its agent; the window's paint applies no resume.
      expect(applyColdRestoreAgentResumeStartup).toHaveBeenCalledExactlyOnceWith(null)
      expect(session.clearSleepingRecordAfterColdRestoreSpawn).not.toHaveBeenCalled()
      expect(session.showSessionRestoredBanner).not.toHaveBeenCalled()
    } else {
      expect(applyColdRestoreAgentResumeStartup).toHaveBeenCalledWith(startup)
    }
    expect(buildColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
    expect(schedulePendingStartupCommandDelivery).not.toHaveBeenCalled()
    expect(context.reattachPayloadApplied).toBe(true)
  })
})

it.each(['missing', 'different', 'admitted'] as const)(
  'authorizes only the checked late saved candidate (%s)',
  async (kind) => {
    await installTerminalTestGlobals()
    try {
      const startup: ColdRestoreAgentResumeStartup = {
        command: 'codex resume C',
        agent: 'codex',
        resumeOrigin: 'saved',
        resumeProviderSession: { key: 'session_id', id: 'C' },
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        launchToken: 'saved-C',
        resumeSource: { cancelled: false },
        useLiveEntry: false,
        hasSleepingRecord: false,
        sleepingRecordEntry: null
      }
      const apply = vi.fn((value) => Boolean(value))
      const cancel = vi.fn()
      const schedule = vi.fn()
      const session = createSession({
        // Main can hand a twin's start back to this renderer-owned launch path.
        mainPaneStartHandedBack: true,
        transport: { getPtyId: () => 'pty-1', disconnect: vi.fn() },
        startFreshColdRestoreAgentResume: vi.fn(),
        buildColdRestoreAgentResumeStartup: () => startup,
        applyColdRestoreAgentResumeStartup: apply,
        cancelSavedResumeStartup: cancel,
        schedulePendingStartupCommandDelivery: schedule,
        clearSleepingRecordAfterColdRestoreSpawn: vi.fn(),
        showSessionRestoredBanner: vi.fn(),
        consumeRestoredViewportBlankingMarker: vi.fn(),
        writeFreshShellViewportBlanking: vi.fn()
      })
      expect(mainStartsPane(session)).toBe(false)
      const context = createContext('', 1)
      context.connectResult = {
        id: 'pty-1',
        coldRestore: { scrollback: '', cwd: '/workspace' },
        ...(kind === 'missing'
          ? {}
          : {
              savedResumeDecision: {
                agent: 'codex',
                providerSession: { key: 'session_id', id: kind === 'different' ? 'D' : 'C' },
                verdict: 'admitted'
              }
            })
      }
      await createReattachPayloadHandlers(session, context).applyReattachPayload()
      expect(apply).not.toHaveBeenCalled()
      expect(schedule).not.toHaveBeenCalled()
      if (kind === 'admitted') {
        expect(session.transport.disconnect).not.toHaveBeenCalled()
        context.resumeAfterReplay?.()
        expect(session.pendingReplacedPtyId).toBe('pty-1')
        expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledWith(startup)
      }
      expect(cancel).toHaveBeenCalledTimes(kind === 'admitted' ? 0 : 1)
    } finally {
      await restoreTerminalTestGlobals()
    }
  }
)

it.each(['missing', 'admitted', 'prepared'] as const)(
  'observes a cached cold owner without consuming an uncorrelated newer recipe (%s)',
  async (kind) => {
    await installTerminalTestGlobals()
    const record = {
      paneKey: 'tab:leaf',
      worktreeId: 'wt',
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'C' },
      state: 'done' as const,
      prompt: '',
      capturedAt: 20,
      updatedAt: 20
    }
    const previousRecords = useAppStore.getState().sleepingAgentSessionsByPaneKey
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: { [record.paneKey]: record } })
    try {
      const startup: ColdRestoreAgentResumeStartup = {
        command: 'codex resume C',
        agent: 'codex',
        resumeOrigin: 'saved',
        resumeProviderSession: record.providerSession,
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        launchToken: 'replacement-token',
        useLiveEntry: false,
        hasSleepingRecord: true,
        sleepingRecordEntry: { paneKey: record.paneKey, record }
      }
      const session = createSession({
        cacheKey: record.paneKey,
        buildColdRestoreAgentResumeStartup: vi.fn(() => startup),
        applyColdRestoreAgentResumeStartup: vi.fn(() => true),
        cancelSavedResumeStartup: vi.fn(),
        schedulePendingStartupCommandDelivery: vi.fn(),
        clearSleepingRecordAfterColdRestoreSpawn: vi.fn(),
        showSessionRestoredBanner: vi.fn(),
        consumeRestoredViewportBlankingMarker: vi.fn(),
        writeFreshShellViewportBlanking: vi.fn()
      })
      const context: ReattachPayloadContext = {
        ...createContext('', 1),
        connectResult: {
          id: 'pty-1',
          isReattach: true,
          coldRestore: { scrollback: 'cached history', cwd: '/workspace' },
          ...(kind === 'admitted'
            ? {
                savedResumeDecision: {
                  agent: 'codex',
                  providerSession: record.providerSession,
                  verdict: 'admitted'
                }
              }
            : {})
        },
        coldRestoreStartup: kind === 'prepared' ? startup : null
      }
      await createReattachPayloadHandlers(session, context).applyReattachPayload()
      expect(session.writeReplayData).toHaveBeenCalledWith(
        expect.stringContaining('cached history')
      )
      expect(window.api.pty.ackColdRestore).toHaveBeenCalledOnce()
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        expect(window.api.pty.ackColdRestore).toHaveBeenCalledWith('pty-1', {
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: session.pane.leafId
        })
      } else {
        expect(window.api.pty.ackColdRestore).toHaveBeenCalledWith('pty-1')
      }
      expect(context.reattachPayloadApplied).toBe(true)
      expect(session.buildColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
      expect(session.applyColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
      expect(session.cancelSavedResumeStartup).not.toHaveBeenCalled()
      expect(session.schedulePendingStartupCommandDelivery).not.toHaveBeenCalled()
      expect(session.clearSleepingRecordAfterColdRestoreSpawn).not.toHaveBeenCalled()
      expect(session.showSessionRestoredBanner).not.toHaveBeenCalled()
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
      expect(window.api.pty.write).not.toHaveBeenCalled()
    } finally {
      useAppStore.setState({ sleepingAgentSessionsByPaneKey: previousRecords })
      await restoreTerminalTestGlobals()
    }
  }
)

it.each([
  'old-remote',
  'checked-remote',
  'adopted',
  'input',
  'local',
  'hidden-local',
  'failed-local'
] as const)('runs late recovery through replay, dispatch and settlement (%s)', async (kind) => {
  await installTerminalTestGlobals()
  vi.useFakeTimers()
  const startup: ColdRestoreAgentResumeStartup = {
    command: 'opencode --session C',
    agent: 'opencode',
    resumeOrigin: 'saved',
    resumeProviderSession: { key: 'session_id', id: 'C' },
    launchToken: 'late-C',
    launchConfig: { agentCommand: 'opencode', agentArgs: '', agentEnv: {} },
    resumeSource: { cancelled: false },
    useLiveEntry: false,
    hasSleepingRecord: false,
    sleepingRecordEntry: null
  }
  const remote = ['old-remote', 'checked-remote', 'adopted', 'input'].includes(kind)
  let id: string | null = 'pty-1'
  const transport = {
    getPtyId: () => id,
    disconnect: vi.fn(() => {
      id = null
    }),
    sendInput: vi.fn(() => true),
    sendInputImmediate: vi.fn(() => true),
    connect: vi.fn(async () => {
      if (kind === 'failed-local') {
        throw new Error('provider failed')
      }
      id = 'fresh'
      return {
        id,
        launchAgent: 'opencode' as const,
        agentResumeUnavailable: true,
        agentResumeRefused: 'unverifiable' as const,
        refusedResume: {
          agent: 'opencode' as const,
          providerSession: { key: 'session_id' as const, id: 'C' }
        }
      }
    })
  }
  const session = createSession({
    cacheKey: 'tab-1:leaf',
    pendingSpawnKey: 'r1-late',
    transport,
    runtimeEnvironmentId: remote ? 'host' : undefined,
    mainPaneStartHandedBack: true,
    disposed: false,
    transportStreamGeneration: 1,
    authoritativeReattachGeneration: 0,
    tabGeneration: 0,
    lastTerminalInputAt: 0,
    pendingStartupCommand: null,
    startupInjectTimer: null,
    shouldDeliverStartupViaTerminalPaste: false,
    buildColdRestoreAgentResumeStartup: () => startup,
    deps: {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      isVisibleRef: { current: true },
      paneTransportsRef: { current: new Map([[1, transport]]) },
      updateTabPtyId: vi.fn()
    },
    ...Object.fromEntries(
      [
        'registerEffectiveLaunchConfig cancelSavedResumeStartup showSessionRestoredBanner',
        'setPanePtyFitBinding reportPanePtyVisibility registerSideEffectFactConsumerForPty',
        'syncHiddenRendererPtyDelivery syncPanePtyLayoutBinding sampleVisiblePaneForegroundAgent',
        'registerPaneSerializerFor scheduleReattachIdleAgentCursorReset settlePaneAttachAttempt',
        'clearPaneMode2031State clearHiddenOutputRestoreState beginReattachLiveDataDeferral',
        'finishReattachLiveDataDeferral clearRegisteredStartupLaunchConfig bindActivePanePty',
        'reconcilePtySizeAfterSpawn releaseUnattemptedStartupDraftPasteDelivery',
        'armStartupDraftReadinessObservation keepUnrunResumeHandle'
      ].flatMap((names) => names.split(' ').map((name) => [name, vi.fn()]))
    ),
    agentCompletionCoordinator: { startProcessTracking: vi.fn() },
    structuralReplayCoordinator: {
      run: async (apply: () => Promise<void>) => {
        await apply()
      }
    },
    shouldDeclareHiddenAtSpawn: () => false,
    terminalRecoveryInstance: { id: 'r1' },
    deferredSpawn: kind === 'failed-local' ? {} : null
  })
  try {
    session.pane.terminal.write = vi.fn((_data, done) => done?.())
    bindDeferredColdRestoreAndSnapshot(session)
    session.clearSleepingRecordAfterColdRestoreSpawn = vi.fn()
    session.resetFreshSpawnFollowOutput = vi.fn()
    session.writeReplayData = vi.fn()
    session.writeInputModeGround = vi.fn()
    session.writeFreshShellViewportBlanking = vi.fn()
    session.consumeRestoredViewportBlankingMarker = vi.fn()
    session.prepareFreshShellViewportForSpawn = vi.fn()
    session.chooseReattachReplayReset = vi.fn(() => '')
    session.captureTransportOutputCallbacks = () => ({
      generation: 1,
      callbacks: {},
      launchContext: {
        startup,
        registration: undefined,
        status: undefined,
        paneStartup: session.paneStartup
      }
    })
    bindHandleReattachResult(session)
    const hidden = kind === 'hidden-local'
    if (hidden) {
      session.deps.isVisibleRef.current = false
      startup.hasSleepingRecord = true
      startup.sleepingRecordEntry = {
        paneKey: session.cacheKey,
        record: {
          paneKey: session.cacheKey,
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          agent: 'opencode',
          providerSession: { key: 'session_id', id: 'C' },
          state: 'done',
          prompt: '',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    }
    const settled = session.handleReattachResult({
      id: 'pty-1',
      coldRestore: { scrollback: 'retained history', cwd: '/workspace' },
      ...(kind === 'adopted' ? { isReattach: true } : {}),
      ...(kind === 'old-remote'
        ? {}
        : {
            savedResumeDecision: {
              agent: 'opencode',
              providerSession: { key: 'session_id', id: 'C' },
              verdict: 'admitted'
            }
          })
    })
    if (kind === 'input') {
      session.lastTerminalInputAt++
    }
    expect(await settled).toBe(true)
    await flushAsyncTicks(20)
    expect(window.api.pty.ackColdRestore).toHaveBeenCalledOnce()
    if (hidden) {
      expect(transport.connect).not.toHaveBeenCalled()
      session.deps.isVisibleRef.current = true
      await session.hibernatedWakeTarget?.wake()
    }
    if (remote) {
      expect(transport.connect).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(50)
      expect(transport.sendInput).toHaveBeenCalledTimes(
        kind === 'adopted' || kind === 'input' ? 0 : 1
      )
      if (kind === 'old-remote' || kind === 'checked-remote') {
        expect(session.pendingStartupCommand).toBeNull()
      }
    } else {
      await pendingSpawnByPaneKey.get(session.pendingSpawnKey)
      await flushAsyncTicks(20)
      expect(transport.connect).toHaveBeenCalledOnce()
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          command: startup.command,
          resumeProviderSession: startup.resumeProviderSession
        })
      )
      expect(pendingSpawnByPaneKey.has(session.pendingSpawnKey)).toBe(false)
      if (kind !== 'failed-local') {
        expect(session.settlePaneAttachAttempt).toHaveBeenLastCalledWith('success')
      } else {
        expect(session.clearRegisteredStartupLaunchConfig).toHaveBeenCalled()
      }
      expect(transport.sendInput).not.toHaveBeenCalled()
    }
  } finally {
    session.disposed = true
    vi.clearAllTimers()
    vi.useRealTimers()
    await restoreTerminalTestGlobals()
  }
})
