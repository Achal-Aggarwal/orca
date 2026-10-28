import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'
import { waitFor } from '../../daemon/daemon-pty-adapter-test-harness'
import { startLateExitHarness } from './daemon-late-exit-test-fixture'
import { ptyIncarnationById } from './provider/ownership-state'
import { installPtyKillIpcHandler } from './ipc/renderer-kill'
import { shutdownProviderAndDetectExit } from './provider/shutdown-detect'
import { stopRevokers } from '../../automations/desktop-run-terminal-stop'

const request = (id: string, expectedIncarnationId: string) => ({
  id,
  expectedIncarnationId,
  requireNoAgentOwner: false,
  requireUnattached: false
})

describe('checked renderer stop route', () => {
  it('revokes only the matching retirement before ordinary IPC Stop subscribes or shuts down', async () => {
    const harness = await startLateExitHarness()
    const matchingKey = 'renderer-stop-matching'
    const unrelatedKey = 'renderer-stop-unrelated'
    const release = vi.fn(() => {
      stopRevokers.delete(matchingKey)
    })
    const unrelated = vi.fn()
    stopRevokers.set(matchingKey, { ptyId: harness.id, release })
    stopRevokers.set(unrelatedKey, { ptyId: 'other-pty', release: unrelated })
    const onExit = harness.adapter.onExit.bind(harness.adapter)
    const shutdown = harness.adapter.shutdown.bind(harness.adapter)
    const subscriptions: ReturnType<typeof vi.fn>[] = []
    const subscription = vi.spyOn(harness.adapter, 'onExit').mockImplementation((listener) => {
      expect(release).toHaveBeenCalledOnce()
      expect(stopRevokers.has(matchingKey)).toBe(false)
      expect(unrelated).not.toHaveBeenCalled()
      const unsubscribe = vi.fn(onExit(listener))
      subscriptions.push(unsubscribe)
      return unsubscribe
    })
    const stop = vi.spyOn(harness.adapter, 'shutdown').mockImplementation(async (id, opts) => {
      expect(release).toHaveBeenCalledOnce()
      expect(stopRevokers.has(matchingKey)).toBe(false)
      expect(id).toBe(harness.id)
      expect(ptyIncarnationById.get(id)).toBe(harness.result.incarnationId)
      expect(opts).toEqual({ immediate: true, keepHistory: false })
      await shutdown(id, opts)
      await harness.waitForExit()
    })
    const physicalExit = vi.spyOn(harness.subprocess, 'forceKill').mockImplementation(() => {
      harness.subprocess._simulateExit(137)
    })
    try {
      await harness.kill()
      expect(stop).toHaveBeenCalledOnce()
      expect(physicalExit).toHaveBeenCalledOnce()
      expect(subscriptions).toHaveLength(1)
      expect(subscriptions[0]).toHaveBeenCalledOnce()
      expect(unrelated).not.toHaveBeenCalled()
      expect(stopRevokers.has(unrelatedKey)).toBe(true)
      expect(harness.providerExits).toEqual([
        {
          id: harness.id,
          code: 137,
          incarnationId: harness.result.incarnationId,
          cause: { kind: 'operator_close' }
        }
      ])
      expect(harness.rendererExits).toHaveLength(1)
      expect(harness.runtime.captureState().connected).toBe(false)
      expect((await harness.capture()).exitListenerCalls).toBe(1)
    } finally {
      subscription.mockRestore()
      stop.mockRestore()
      physicalExit.mockRestore()
      stopRevokers.delete(matchingKey)
      stopRevokers.delete(unrelatedKey)
      await harness.dispose()
    }
  })

  it('keeps retirement authorization and requires an observed matching exit, not just a shutdown ACK', async () => {
    const harness = await startLateExitHarness()
    const matchingKey = 'authorized-stop-matching'
    const unrelatedKey = 'authorized-stop-unrelated'
    const release = vi.fn()
    const unrelated = vi.fn()
    stopRevokers.set(matchingKey, { ptyId: harness.id, release })
    stopRevokers.set(unrelatedKey, { ptyId: 'other-pty', release: unrelated })
    const onExit = harness.adapter.onExit.bind(harness.adapter)
    const subscriptions: ReturnType<typeof vi.fn>[] = []
    const subscription = vi.spyOn(harness.adapter, 'onExit').mockImplementation((listener) => {
      expect(release).not.toHaveBeenCalled()
      const unsubscribe = vi.fn(onExit(listener))
      subscriptions.push(unsubscribe)
      return unsubscribe
    })
    const authorizeStop = vi.fn(async () => true)
    const opts = {
      immediate: true,
      keepHistory: false,
      expectedIncarnationId: harness.result.incarnationId,
      authorizeStop
    }
    const stop = vi.spyOn(harness.adapter, 'shutdown')
    const physicalExit = vi.spyOn(harness.subprocess, 'forceKill').mockImplementation(() => {
      harness.subprocess._simulateExit(137)
    })
    try {
      harness.pauseStream()
      await expect(shutdownProviderAndDetectExit(harness.adapter, harness.id, opts)).resolves.toBe(
        false
      )
      expect(stop).toHaveBeenCalledExactlyOnceWith(harness.id, opts)
      expect(authorizeStop).toHaveBeenCalledOnce()
      expect(physicalExit).toHaveBeenCalledOnce()
      expect(subscriptions).toHaveLength(1)
      expect(subscriptions[0]).toHaveBeenCalledOnce()
      expect(release).not.toHaveBeenCalled()
      expect(unrelated).not.toHaveBeenCalled()
      expect(stopRevokers.has(matchingKey)).toBe(true)
      expect(stopRevokers.has(unrelatedKey)).toBe(true)
      expect(harness.providerExits).toHaveLength(0)
      harness.resumeStream()
      await harness.waitForExit()
      expect(harness.providerExits).toEqual([
        {
          id: harness.id,
          code: 137,
          incarnationId: harness.result.incarnationId,
          cause: { kind: 'operator_close' }
        }
      ])
      expect(harness.rendererExits).toHaveLength(1)
    } finally {
      subscription.mockRestore()
      stop.mockRestore()
      physicalExit.mockRestore()
      stopRevokers.delete(matchingKey)
      stopRevokers.delete(unrelatedKey)
      await harness.dispose()
    }
  })

  it('refuses missing identity without falling through to the unfenced stop', async () => {
    const harness = await startLateExitHarness()
    try {
      const markStop = vi.spyOn(harness.runtime, 'markPtyStopRequested')
      await expect(harness.killFenced({ id: harness.id })).resolves.toEqual({
        outcome: 'refused',
        reason: 'unsupported'
      })
      expect(harness.subprocess.forceKill).not.toHaveBeenCalled()
      expect(markStop).not.toHaveBeenCalled()
      expect(harness.rendererExits).toHaveLength(0)
      expect(harness.runtime.captureState().connected).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('leaves replacement ownership and runtime status untouched on refusal', async () => {
    const harness = await startLateExitHarness()
    try {
      const before = harness.runtime.captureState()
      const markStop = vi.spyOn(harness.runtime, 'markPtyStopRequested')
      await expect(harness.killFenced(request(harness.id, 'old-incarnation'))).resolves.toEqual({
        outcome: 'refused',
        reason: 'replaced'
      })
      expect(harness.runtime.captureState()).toEqual(before)
      expect(ptyIncarnationById.get(harness.id)).toBe(harness.result.incarnationId)
      expect(markStop).not.toHaveBeenCalled()
      expect(harness.rendererExits).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses old providers at dispatch, and retains ownership after a lost kill response', async () => {
    const harness = await startLateExitHarness()
    try {
      const supports = vi.spyOn(harness.adapter, 'supportsFencedTermination').mockReturnValue(false)
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'refused', reason: 'unsupported' })
      supports.mockRestore()
      vi.spyOn(harness.adapter, 'killFenced').mockRejectedValue(new Error('response lost'))
      const markStop = vi.spyOn(harness.runtime, 'markPtyStopRequested')
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
      expect(markStop).not.toHaveBeenCalled()
      expect(ptyIncarnationById.get(harness.id)).toBe(harness.result.incarnationId)
      expect(harness.rendererExits).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('ends a tab-less terminal this run spawned, though main holds its stream', async () => {
    const harness = await startLateExitHarness()
    try {
      await expect(
        harness.killFenced({
          ...request(harness.id, harness.result.incarnationId ?? 'missing'),
          requireUnattached: true
        })
      ).resolves.toEqual({ outcome: 'ended' })
    } finally {
      await harness.dispose()
    }
  })

  it('keeps the daemon attached check when no runtime can answer for viewers', async () => {
    const harness = await startLateExitHarness()
    try {
      installPtyKillIpcHandler({
        getLocalPtyProviderStartupPromise: () => undefined,
        shutdownProviderAndDetectExit,
        rememberSyntheticKillExit: harness.session.rememberSyntheticKillExit,
        sendPtyExitToRenderer: harness.session.sendPtyExitToRenderer
      })
      await expect(
        harness.killFenced({
          ...request(harness.id, harness.result.incarnationId ?? 'missing'),
          requireUnattached: true
        })
      ).resolves.toEqual({ outcome: 'refused', reason: 'attached' })
    } finally {
      await harness.dispose()
    }
  })

  it('ends a tab-less restart survivor once main attaches it', async () => {
    const harness = await startLateExitHarness()
    const previousRun = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    try {
      const survivorId = 'repo::/tmp/late-exit-audit@@survivor'
      const survivor = await previousRun.spawn({ cols: 80, rows: 24, sessionId: survivorId })
      const detached = vi.spyOn(harness.server['attachments'], 'detachClientSessions')
      await previousRun.disconnectOnly()
      await waitFor(() => detached.mock.calls.length > 0)
      await harness.adapter.attach(survivorId)
      await expect(
        harness.killFenced({
          ...request(survivorId, survivor.incarnationId ?? 'missing'),
          requireUnattached: true
        })
      ).resolves.toEqual({ outcome: 'ended' })
    } finally {
      await harness.dispose()
    }
  })

  it('refuses a tab-less end while a pane or remote view uses the terminal', async () => {
    const harness = await startLateExitHarness()
    try {
      const checked = {
        ...request(harness.id, harness.result.incarnationId ?? 'missing'),
        requireUnattached: true
      }
      const releaseRemote = harness.runtime.registerRemoteTerminalViewSubscriber(harness.id)
      await expect(harness.killFenced(checked)).resolves.toEqual({
        outcome: 'refused',
        reason: 'attached'
      })
      releaseRemote()
      harness.runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo::/tmp/late-exit-audit',
            title: '',
            activeLeafId: 'leaf-1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo::/tmp/late-exit-audit',
            leafId: 'leaf-1',
            paneRuntimeId: 1,
            ptyId: harness.id,
            paneTitle: ''
          }
        ]
      })
      await expect(harness.killFenced(checked)).resolves.toEqual({
        outcome: 'refused',
        reason: 'attached'
      })
      expect(harness.subprocess.forceKill).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it('preserves operator-close provenance when the physical exit beats the control response', async () => {
    const harness = await startLateExitHarness()
    try {
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'ended' })
      await harness.waitForExit()
      expect(harness.runtime.captureState().exitCause).toEqual({ kind: 'operator_close' })
    } finally {
      await harness.dispose()
    }
  })

  it('synthesizes an exit only for the proven incarnation when its control response beats the stream', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.pauseStream()
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'ended' })
      expect(harness.runtime.captureState().connected).toBe(false)
      expect(harness.rendererExits).toEqual([
        { id: harness.id, code: -1, incarnationId: harness.result.incarnationId }
      ])
      harness.resumeStream()
      await harness.waitForExit()
      expect(harness.rendererExits).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })
})
