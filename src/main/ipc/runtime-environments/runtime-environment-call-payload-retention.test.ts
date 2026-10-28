import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { registerRuntimeEnvironmentPassiveHandlers } from './runtime-environment-connectivity-handlers'
import { channelHandlerLookup, pairingCode } from './runtime-environments-ipc-test-harness'

const { handle, getPath, cachedRequest } = vi.hoisted(() => ({
  handle: vi.fn(),
  getPath: vi.fn(),
  cachedRequest: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle }
}))

vi.mock('./runtime-environment-managed-tunnel', async () => {
  const { resolveEnvironment } = await import('../../../shared/runtime-environment-store')
  return {
    resolveManagedRuntimeEnvironment: async (profile: string, selector: string) =>
      resolveEnvironment(profile, selector)
  }
})

vi.mock('./runtime-environment-request-connections', () => ({
  sendRemoteRuntimeConnectionRequest: cachedRequest,
  sendRemoteRuntimeSharedControlRequest: vi.fn(),
  sendRemoteRuntimeSharedControlRequestOnRuntime: vi.fn(),
  subscribeRemoteRuntimeSharedControlRequest: vi.fn(),
  getRemoteRuntimeSharedControlDiagnostics: () => null,
  getRuntimeEnvironmentStatusOwner: vi.fn(),
  getRuntimeEnvironmentStatusSnapshots: () => [],
  closeRemoteRuntimeRequestConnection: vi.fn()
}))

function runtimeResponseGate(): {
  promise: Promise<RuntimeRpcResponse<unknown>>
  release: () => void
} {
  let release = (): void => {}
  const promise = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
    release = () =>
      resolve({ id: 'sent', ok: true, result: null, _meta: { runtimeId: 'runtime-a' } })
  })
  return { promise, release }
}

describe('paired runtime call payload ownership', () => {
  let profile: string

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'orca-runtime-payload-'))
    handle.mockReset()
    getPath.mockReturnValue(profile)
    cachedRequest.mockReset()
  })

  afterEach(() => {
    rmSync(profile, { recursive: true, force: true })
  })

  it('releases the original queued graph through the passive IPC and account boundary', async () => {
    const wait = runtimeResponseGate()
    cachedRequest.mockReturnValue(wait.promise)
    const environment = addEnvironmentFromPairingCode(profile, {
      name: 'paired',
      pairingCode: pairingCode()
    })
    registerRuntimeEnvironmentPassiveHandlers(() => profile)
    const call = channelHandlerLookup(handle)<
      { selector: string; method: string; params: unknown },
      RuntimeRpcResponse<unknown>
    >('runtimeEnvironments:call')
    const invoke = (params: unknown) =>
      Promise.resolve(call(null, { selector: environment.id, method: 'terminal.send', params }))
    const blockers = Array.from({ length: 8 }, () => invoke({ terminal: 't', text: 'blocker' }))
    const enqueue = () => {
      const params = { terminal: 't', text: 'x'.repeat(512 * 1024) }
      return { ref: new WeakRef(params), pending: invoke(params) }
    }
    const queued = enqueue()
    try {
      if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
        throw new Error('The test runner must enable --expose-gc')
      }
      for (let round = 0; round < 3; round += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        globalThis.gc()
      }
      expect(cachedRequest).toHaveBeenCalledTimes(8)
      expect(queued.ref.deref()).toBeUndefined()
    } finally {
      wait.release()
      await Promise.allSettled([...blockers, queued.pending])
    }
    expect(await queued.pending).toMatchObject({ ok: true })
  })

  it('charges active and waiting payloads across selectors and releases queued abort credit', async () => {
    const wait = runtimeResponseGate()
    cachedRequest.mockReturnValue(wait.promise)
    const environments = ['first', 'second'].map((name, index) =>
      addEnvironmentFromPairingCode(profile, {
        name,
        pairingCode: pairingCode(`ws://${name}.example:6768`, {
          keyByte: index + 1,
          deviceToken: name
        })
      })
    )
    const first = environments[0]
    const second = environments[1]
    if (!first || !second) {
      throw new Error('Expected both paired environments')
    }
    const invoke = (selector: string, signal?: AbortSignal) =>
      callRuntimeEnvironment(
        profile,
        selector,
        'terminal.send',
        { terminal: 't', text: 'x'.repeat(512 * 1024) },
        undefined,
        undefined,
        undefined,
        { signal }
      )
    const controller = new AbortController()
    const activeAndWaiting = Array.from({ length: 20 }, (_, index) =>
      invoke(index % 2 === 0 ? first.id : second.id)
    )
    const queued = invoke(first.id, controller.signal)
    const cancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    let replacement: Promise<RuntimeRpcResponse<unknown>> | undefined
    try {
      await expect(invoke(second.id)).rejects.toMatchObject({
        code: 'runtime_rpc_queue_overloaded',
        scope: 'memory'
      })
      expect(cachedRequest).toHaveBeenCalledTimes(16)
      controller.abort()
      await cancelled
      let rejected = false
      replacement = invoke(second.id)
      void replacement.catch(() => {
        rejected = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(rejected).toBe(false)
      expect(cachedRequest).toHaveBeenCalledTimes(16)
    } finally {
      controller.abort()
      wait.release()
      await Promise.allSettled([
        ...activeAndWaiting,
        queued,
        cancelled,
        ...(replacement ? [replacement] : [])
      ])
    }
    await expect(invoke(first.id)).resolves.toMatchObject({ ok: true })
  })
})
