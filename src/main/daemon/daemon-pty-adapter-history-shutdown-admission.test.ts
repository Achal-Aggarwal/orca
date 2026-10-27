import './mock-descendant-sweep'
import { expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import { getHistorySessionDirName } from './history-paths'
import type * as DaemonHealthModule from './daemon-health'

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: vi.fn(async () => 'unknown')
  }
})

it('drains keepHistory shutdowns admitted before connection preparation completes', async () => {
  const subprocess = createMockSubprocess()
  const harness = await startDaemonAdapterHarness(() => subprocess)
  const historyDir = join(harness.dir, 'history')
  const adapter = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    historyPath: historyDir
  })
  try {
    const { id } = await adapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'sleep-admitted-before-preparation'
    })
    subprocess._simulateData('admitted sleep output\r\n')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected members match the adapter declarations; only connection preparation is gated.
    const internals = adapter as unknown as {
      ensureConnected(deadlineMs?: number): Promise<void>
      keepHistoryShutdowns: Set<Promise<void>>
    }
    const originalEnsureConnected = internals.ensureConnected.bind(adapter)
    let releasePreparation!: () => void
    const preparationRelease = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    vi.spyOn(internals, 'ensureConnected').mockImplementationOnce(async (deadlineMs) => {
      await preparationRelease
      await originalEnsureConnected(deadlineMs)
    })

    const shuttingDown = adapter.shutdown(id, { immediate: true, keepHistory: true })
    const admittedBeforeYield = internals.keepHistoryShutdowns.size
    const disconnecting = adapter.disconnectOnly()
    const operations = Promise.allSettled([shuttingDown, disconnecting])
    try {
      expect(admittedBeforeYield).toBe(1)
      await expect(adapter.shutdown(id, { immediate: true, keepHistory: true })).rejects.toThrow(
        'Cannot keep history after daemon disconnect has started'
      )
    } finally {
      releasePreparation()
      await operations
    }

    expect(await operations).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined }
    ])
    expect(internals.keepHistoryShutdowns.size).toBe(0)
    expect(adapter.getActiveSessionIds()).not.toContain(id)
    const sessionDir = join(historyDir, getHistorySessionDirName(id))
    const checkpoint = JSON.parse(readFileSync(join(sessionDir, 'checkpoint.json'), 'utf-8'))
    expect(checkpoint.snapshotAnsi).toContain('admitted sleep output')
    expect(JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf-8')).endedAt).toBeNull()
  } finally {
    adapter.dispose()
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

it.each(['cwd', 'checkpoint', 'lock'] as const)(
  'authorizes only after real daemon %s preparation and preserves live history on veto',
  async (pause) => {
    const subprocess = createMockSubprocess()
    const harness = await startDaemonAdapterHarness(() => subprocess)
    const adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      historyPath: join(harness.dir, 'history')
    })
    try {
      const { id, incarnationId } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: `veto-${pause}`
      })
      subprocess._simulateData('keep this live history\r\n')
      // SAFETY: protected adapter owners are exposed only to pause their real preparation, not replace stop dispatch.
      const inside = adapter as unknown as {
        readLiveSleepCwd(id: string, deadline?: number): Promise<string | null>
        checkpointSessions(
          ids: string[],
          opts: { final: boolean; teardown: boolean }
        ): Promise<void>
        withHistorySpawnLock<T>(id: string, operation: () => Promise<T>): Promise<T>
        coldRestoreCache: Map<string, unknown>
        sleepRestoreSessionIds: Set<string>
        sessionIncarnations: Map<string, string>
        historyManager: { hasWriter(id: string): boolean }
      }
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      if (pause === 'cwd') {
        const actual = inside.readLiveSleepCwd.bind(adapter)
        vi.spyOn(inside, 'readLiveSleepCwd').mockImplementationOnce(async (...args) => {
          entered.resolve()
          await resume.promise
          return actual(...args)
        })
      } else if (pause === 'checkpoint') {
        const actual = inside.checkpointSessions.bind(adapter)
        vi.spyOn(inside, 'checkpointSessions').mockImplementationOnce(async (...args) => {
          entered.resolve()
          await resume.promise
          return actual(...args)
        })
      } else {
        const actual = inside.withHistorySpawnLock.bind(adapter)
        vi.spyOn(inside, 'withHistorySpawnLock').mockImplementationOnce(async (key, operation) => {
          entered.resolve()
          await resume.promise
          return actual(key, operation)
        })
      }
      let untouched = true
      const authorizeStop = vi.fn(async () => untouched)
      const shutdown = adapter.shutdown(id, {
        immediate: true,
        keepHistory: true,
        expectedIncarnationId: incarnationId,
        authorizeStop
      })
      const denied = expect(shutdown).rejects.toThrow('terminal_stop_declined')
      await entered.promise
      expect(authorizeStop).not.toHaveBeenCalled()
      untouched = false
      resume.resolve()
      await denied
      expect(subprocess.kill).not.toHaveBeenCalled()
      expect(adapter.getActiveSessionIds()).toContain(id)
      expect(inside.coldRestoreCache.has(id)).toBe(false)
      expect(inside.sleepRestoreSessionIds.has(id)).toBe(false)
      expect(inside.historyManager.hasWriter(id)).toBe(true)
      // An ordinary Stop does not require the rejected automatic authority.
      await adapter.shutdown(id, { immediate: true, keepHistory: true })
      expect(subprocess.forceKill).toHaveBeenCalledOnce()
    } finally {
      adapter.dispose()
      harness.adapter.dispose()
      await harness.server.shutdown()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  }
)
