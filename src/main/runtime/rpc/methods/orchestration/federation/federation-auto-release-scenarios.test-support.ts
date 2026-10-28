import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcRequest } from '../../../core'

type AutoReleaseScenarioHarness = {
  startRemoteWorker: () => Promise<string>
  dispatchHome: (request: RpcRequest) => Promise<RuntimeRpcResponse<unknown>>
  dispatchWorker: (request: RpcRequest) => Promise<RuntimeRpcResponse<unknown>>
  syncHome: (dispatchId: string) => Promise<unknown>
  workerRuntime: () => OrcaRuntimeService
  homeDb: () => OrchestrationDb
  workerDb: () => OrchestrationDb
  remoteCalls: () => string[]
  // Mixed versions: a host without the capability, or a home that never opts in on ack.
  setWorkerAdvertisesAutoRelease: (advertised: boolean) => void
  setHomeOmitsAutoRelease: (omitted: boolean) => void
}

const GRACE_MS = 2 * 60_000

export function registerFederatedAutoReleaseScenarios(harness: AutoReleaseScenarioHarness): void {
  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(harness.workerRuntime()).clear()
    vi.useRealTimers()
  })

  async function settleRemotely(): Promise<string> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    const dispatchId = await harness.startRemoteWorker()
    const taskId = harness.homeDb().getDispatchContextById(dispatchId)!.task_id
    const sent = harness.dispatchWorker({
      id: 'rpc_remote_worker_done',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_worker_done',
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      }
    })
    await vi.waitFor(() =>
      expect(harness.workerDb().listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
    )
    // Queued, not yet accepted by the home: no deadline.
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBe(
      null
    )
    await harness.syncHome(dispatchId)
    await expect(sent).resolves.toMatchObject({ ok: true })
    return dispatchId
  }

  async function releaseDueOnHost(): Promise<void> {
    vi.setSystemTime(Date.now() + GRACE_MS)
    await getWorkerTerminalAutoReleaseScheduler(harness.workerRuntime()).releaseDue()
  }

  function retainFromHome(dispatchId: string) {
    return harness.dispatchHome({
      id: 'rpc_remote_retain',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_retain',
      method: 'orchestration.workerRetain',
      params: { dispatch: dispatchId }
    })
  }

  it('arms the host deadline once the home accepts worker_done, then releases there', async () => {
    const dispatchId = await settleRemotely()
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      auto_release_at: '2026-10-27 12:02:00'
    })
    await expect(
      harness.dispatchHome({
        id: 'rpc_remote_show',
        authToken: 'coordinator-token',
        method: 'orchestration.workerShow',
        params: { dispatch: dispatchId }
      })
    ).resolves.toMatchObject({ result: { autoReleaseAt: '2026-10-27T12:02:00Z' } })

    await releaseDueOnHost()

    expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledWith('term_windows_worker')
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe(
      'released'
    )
  })

  it('forwards worker-retain to the host so its deadline never fires', async () => {
    const dispatchId = await settleRemotely()

    await expect(retainFromHome(dispatchId)).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'user_requested' }
    })
    await releaseDueOnHost()

    expect(harness.remoteCalls()).toContain('orchestration.federationRetain')
    expect(harness.workerRuntime().closeTerminal).not.toHaveBeenCalled()
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'retained',
      auto_release_at: null
    })
  })

  it('keeps manual release when the home predates automatic release', async () => {
    harness.setHomeOmitsAutoRelease(true)
    const dispatchId = await settleRemotely()

    await releaseDueOnHost()

    expect(harness.workerDb().getRemoteDispatchAttachment(dispatchId)?.state).toBe('succeeded')
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'not_requested',
      auto_release_at: null
    })
    expect(harness.workerRuntime().closeTerminal).not.toHaveBeenCalled()
  })

  it('keeps worker-retain home-only for a host that predates automatic release', async () => {
    harness.setWorkerAdvertisesAutoRelease(false)
    const dispatchId = await harness.startRemoteWorker()

    await expect(retainFromHome(dispatchId)).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'no_owned_resource' }
    })
    expect(harness.remoteCalls()).not.toContain('orchestration.federationRetain')
  })
}
