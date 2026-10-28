import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const GRACE_MS = 2 * 60_000

describe('orchestration worker automatic release', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
    vi.useRealTimers()
  })

  function setupWithFakeClock(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    h.setup()
  }

  it.each(['succeeded', 'failed'] as const)(
    'releases a %s worker once its grace period ends and keeps its output readable',
    async (outcome) => {
      setupWithFakeClock()
      const { dispatchId } = await h.startSettledWorker(outcome)
      await expect(
        h.call('orchestration.workerShow', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        autoReleaseAt: '2026-10-27T12:02:00Z',
        terminalResource: { autoReleaseAt: '2026-10-27T12:02:00Z' },
        projection: { nextAction: { kind: 'none' } }
      })

      await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000)
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)

      await vi.waitFor(() =>
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
      )
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
      expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
      await expect(
        h.call('orchestration.workerRead', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        terminal: { tail: ['worker output line 1', 'worker output line 2'] }
      })
    }
  )

  it('never extends the deadline for a repeated worker_done', async () => {
    setupWithFakeClock()
    const { taskId, dispatchId } = await h.startSettledWorker()
    const armed = h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at
    await vi.advanceTimersByTimeAsync(60_000)

    h.settle(taskId, dispatchId, 'succeeded')

    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBe(armed)
  })

  it('hands a terminal reused during the grace period to the new Dispatch', async () => {
    setupWithFakeClock()
    const settled = await h.startSettledWorker()

    const reuse = await h.startWorker({ terminal: 'term_worker' })
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(settled.dispatchId)).toBeUndefined()
    expect(h.db.getWorkerTerminalResourceByOwner(reuse.dispatchId)).toMatchObject({
      release_state: 'not_requested',
      auto_release_at: null
    })
  })

  it.each([
    [
      'worker-retain',
      'orchestration.workerRetain',
      (dispatchId: string) => ({ dispatch: dispatchId })
    ],
    [
      'Keep Worker Open action',
      'orchestration.workerTerminalUserKeep',
      () => ({ paneKey: h.workerPaneKey })
    ],
    ['user input', 'orchestration.workerTerminalUserInput', () => ({ paneKey: h.workerPaneKey })]
  ] as const)(
    'keeps a terminal the %s claimed before the deadline',
    async (_kind, method, params) => {
      setupWithFakeClock()
      const { dispatchId } = await h.startSettledWorker()

      await h.call(method, params(dispatchId))
      await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        release_state: 'retained',
        auto_release_at: null
      })
    }
  )

  it('keeps a terminal the user typed into while its output was being captured', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()
    const pendingRead = h.deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
    vi.mocked(h.runtime.readTerminal).mockReturnValue(pendingRead.promise)

    await vi.advanceTimersByTimeAsync(GRACE_MS)
    await vi.waitFor(() => expect(h.runtime.readTerminal).toHaveBeenCalledTimes(1))
    await h.call('orchestration.workerTerminalUserInput', { paneKey: h.workerPaneKey })
    pendingRead.resolve({
      handle: 'term_worker',
      status: 'running',
      tail: ['typed during capture'],
      truncated: false,
      nextCursor: '1'
    })

    await vi.waitFor(() =>
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('user_owned')
    )
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('does not arm a worker retained before it reported', async () => {
    setupWithFakeClock()
    const { taskId, dispatchId } = await h.startWorker()
    await h.call('orchestration.workerRetain', { dispatch: dispatchId })

    h.settle(taskId, dispatchId, 'succeeded')
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBeNull()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it.each([
    ['silent', async () => (await h.startWorker()).dispatchId],
    [
      'abandoned',
      async () => {
        const { dispatchId } = await h.startWorker()
        await h.call('orchestration.workerAbandon', { dispatch: dispatchId })
        return dispatchId
      }
    ],
    [
      'pre-upgrade settled',
      async () => {
        const { dispatchId } = await h.startSettledWorker()
        h.db.db
          .prepare(
            'UPDATE worker_terminal_resources SET auto_release_at = NULL, auto_release_dispatch_id = NULL WHERE owner_dispatch_id = ?'
          )
          .run(dispatchId)
        return dispatchId
      }
    ]
  ] as const)('leaves a %s worker to manual release', async (_state, start) => {
    setupWithFakeClock()
    const dispatchId = await start()

    getWorkerTerminalAutoReleaseScheduler(h.runtime).rearm()
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBeNull()
  })

  it('releases a deadline that passed while the runtime was down exactly once', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()
    const scheduler = getWorkerTerminalAutoReleaseScheduler(h.runtime)
    scheduler.clear()
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()

    await Promise.all([scheduler.releaseDue(), scheduler.releaseDue()])
    await scheduler.releaseDue()

    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('never arms a chat worker, whose draft has no activity signal', () => {
    const db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'structured' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.recordCreatedWorkerTerminalCustody({
      dispatchId: dispatch.id,
      handle: 'structworker_1',
      paneKey: 'tab_s:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      processIncarnation: 'structured:1',
      worktreeId: 'wt'
    })

    db.armWorkerTerminalAutoReleaseStatement(dispatch.id)

    expect(db.getWorkerTerminalResourceByOwner(dispatch.id)?.auto_release_at).toBeNull()
    db.close()
  })
})
