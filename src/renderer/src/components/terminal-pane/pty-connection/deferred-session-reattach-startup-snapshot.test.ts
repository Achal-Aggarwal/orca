import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentStatusStartupSnapshot } from '@/hooks/ipc-events/agent-status-startup-snapshot'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { PtyTransport } from '../pty-transport-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

vi.mock('../terminal-lifecycle-diagnostics', () => ({ warnTerminalLifecycleAnomaly: vi.fn() }))
vi.mock('./paired-parked-terminal-restore', () => ({ isRemoteRuntimePtyId: () => false }))
vi.mock('./pty-connect-limits', () => ({
  recordPtyConnectDiagnostic: vi.fn(),
  isSshSessionGoneError: () => false
}))

function createSession(
  runtimeEnvironmentId?: string,
  transport: Pick<PtyTransport, 'connect' | 'getPtyId'> = {
    connect: vi.fn().mockResolvedValue(null),
    getPtyId: () => 'restored-pty'
  }
) {
  let startup: {
    command: string
    agent: string
    resumeProviderSession: { key: string; id: string }
  } | null = null
  const fixture = {
    runtimeEnvironmentId,
    pane: { id: 1 },
    transport,
    disposed: false,
    transportStreamGeneration: 1,
    deps: { paneTransportsRef: { current: new Map([[1, transport]]) } },
    buildColdRestoreAgentResumeStartup: () => startup,
    captureTransportOutputCallbacks: () => ({ generation: 1, callbacks: {} }),
    beginReattachLiveDataDeferral: vi.fn(),
    finishReattachLiveDataDeferral: vi.fn(),
    shouldDeclareHiddenAtSpawn: () => true,
    handleReattachResult: vi.fn().mockResolvedValue(true),
    reportError: vi.fn(),
    cols: 80,
    rows: 24,
    cacheKey: 'tab:leaf'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture provides every session field read by deferred reattach; unrelated installers are not exercised.
  const session = fixture as unknown as ConnectPanePtySession
  return {
    fixture,
    session,
    transport,
    replay: () => {
      startup = {
        command: "cursor-agent '--resume' 'conversation-742'",
        agent: 'cursor',
        resumeProviderSession: { key: 'conversation_id', id: 'conversation-742' }
      }
    }
  }
}

describe('cold reattach waits for host identity replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      api: { pty: { declarePendingPaneSerializer: vi.fn().mockResolvedValue(null) } }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each([false, true])(
    'routes the actual status-only caller through remote owner ingress (modern %s)',
    async (modern) => {
      vi.resetModules()
      const call = vi.fn(async ({ method }: { method: string }) =>
        method === 'terminal.create'
          ? {
              ok: false,
              error: {
                code: 'terminal_spawn_deferred',
                message: 'terminal_spawn_deferred:paused',
                data: { reason: 'paused' }
              }
            }
          : method === 'terminal.resolvePane'
            ? { ok: false, error: { code: 'terminal_not_found', message: 'terminal_not_found' } }
            : {
                ok: true,
                result:
                  method === 'status.get'
                    ? {
                        runtimeProtocolVersion: 3,
                        minCompatibleRuntimeClientVersion: 2,
                        capabilities: modern ? ['terminal.spawn-intent.v1'] : []
                      }
                    : { terminal: null }
              }
      )
      Object.assign(window.api, { runtimeEnvironments: { call, subscribe: vi.fn() } })
      const { createRemoteRuntimePtyTransport } = await import('../remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'repo::/work',
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111'
      })
      const attempt = createSession('env-1', transport)
      startDeferredSessionReattach(attempt.session, 'lost-host-pty')
      await vi.waitFor(() =>
        expect(call.mock.calls.some(([args]) => args.method === 'terminal.create')).toBe(true)
      )
      const request = call.mock.calls.find(([args]) => args.method === 'terminal.create')?.[0]
      expect(request).toMatchObject({ params: { tabId: 'tab-1' } })
      if (modern) {
        expect(request).toMatchObject({ params: { spawnIntent: 'automatic-restore' } })
      } else {
        expect(request).not.toMatchObject({ params: { spawnIntent: expect.anything() } })
      }
      transport.disconnect()
    }
  )

  it('connects synchronously when host replay already applied before pane registration', () => {
    const bridge = registerAgentStatusStartupSnapshot()
    bridge.settle()
    const { session, fixture, transport } = createSession()
    fixture.deps.paneTransportsRef.current.clear()
    startDeferredSessionReattach(session, 'live-pty')
    expect(transport.connect).toHaveBeenCalledOnce()
    fixture.deps.paneTransportsRef.current.set(1, transport)
    bridge.dispose()
  })

  it('connects once with the exact conversation after the initial snapshot applies', async () => {
    const bridge = registerAgentStatusStartupSnapshot()
    const { session, transport, replay } = createSession()
    startDeferredSessionReattach(session, 'lost-pty')
    expect(transport.connect).not.toHaveBeenCalled()
    replay()
    bridge.settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.connect).toHaveBeenCalledOnce()
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main's start resumes the conversation; the window's reattach is a view.
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'lost-pty',
          attachOnlyView: true,
          initiallyHidden: true
        })
      )
      expect(transport.connect).toHaveBeenCalledWith(
        expect.not.objectContaining({ command: expect.anything() })
      )
      bridge.dispose()
      return
    }
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "cursor-agent '--resume' 'conversation-742'",
        resumeProviderSession: { key: 'conversation_id', id: 'conversation-742' },
        initiallyHidden: true
      })
    )
    bridge.dispose()
  })

  it.each(['disposed', 'replaced', 'generation'] as const)(
    'never connects an obsolete %s pane after waiting',
    async (kind) => {
      const bridge = registerAgentStatusStartupSnapshot()
      const { session, fixture, transport } = createSession()
      startDeferredSessionReattach(session, 'lost-pty')
      if (kind === 'disposed') {
        fixture.disposed = true
      }
      if (kind === 'replaced') {
        fixture.deps.paneTransportsRef.current.delete(1)
      }
      if (kind === 'generation') {
        fixture.transportStreamGeneration += 1
      }
      bridge.settle()
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.connect).not.toHaveBeenCalled()
      bridge.dispose()
    }
  )

  it('retains the bounded fallback when the host never answers', async () => {
    const bridge = registerAgentStatusStartupSnapshot()
    const { session, transport } = createSession()
    startDeferredSessionReattach(session, 'lost-pty')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(transport.connect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.connect).toHaveBeenCalledOnce()
    bridge.dispose()
  })

  it('ignores an old bridge completion after replacement', async () => {
    const old = registerAgentStatusStartupSnapshot()
    const { session, transport, replay } = createSession()
    startDeferredSessionReattach(session, 'lost-pty')
    const replacement = registerAgentStatusStartupSnapshot()
    old.settle()
    old.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.connect).not.toHaveBeenCalled()
    replay()
    replacement.settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.connect).toHaveBeenCalledOnce()
    replacement.dispose()
  })
})
