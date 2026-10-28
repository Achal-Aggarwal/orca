import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

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

async function installBlockedCalls(wait: Promise<RuntimeRpcResponse<unknown>>) {
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(): Promise<RuntimeRpcResponse<unknown>> {
        return wait
      }
      close(): void {}
    }
  }))
  const globals = installBrowserGlobals()
  writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
  const calls = await import('./preload-api/web-runtime-calls')
  const { captureWebFileMutationSession } = await import('./preload-api/web-filesystem-api')
  return { ...calls, captureWebFileMutationSession }
}

describe('web paired runtime payload ownership', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it.each(['result', 'owner', 'captured'] as const)(
    'releases original queued arguments through the %s entry chain',
    async (entry) => {
      const wait = runtimeResponseGate()
      const calls = await installBlockedCalls(wait.promise)
      const invoke =
        entry === 'captured'
          ? calls.captureWebFileMutationSession().callRuntimeResult
          : entry === 'owner'
            ? calls.callRuntimeResultWithOwner
            : calls.callRuntimeResult
      const blockers = Array.from({ length: 8 }, () =>
        calls.callRuntimeEnvelope('files.write', { content: 'blocker' })
      )
      const enqueue = () => {
        const params = { content: 'x'.repeat(512 * 1024) }
        return { ref: new WeakRef(params), pending: invoke('files.write', params) }
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
        expect(queued.ref.deref()).toBeUndefined()
      } finally {
        wait.release()
        await Promise.allSettled([...blockers, queued.pending])
      }
    }
  )

  it.each(['active', 'environment', 'captured'] as const)(
    'enforces the payload budget and restores capacity through the %s admission',
    async (entry) => {
      const wait = runtimeResponseGate()
      const calls = await installBlockedCalls(wait.promise)
      const invoke =
        entry === 'captured'
          ? calls.captureWebFileMutationSession().callRuntimeResult
          : entry === 'environment'
            ? (method: string, params: unknown) =>
                calls.callEnvironmentEnvelope('web-server-a', method, params)
            : calls.callRuntimeEnvelope
      let overloads = 0
      const unexpected: unknown[] = []
      const pending = Array.from({ length: 32 }, (_, index) =>
        invoke('files.write', { content: String(index).padEnd(512 * 1024, 'x') }).catch(
          (error: unknown) => {
            if (
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'runtime_rpc_queue_overloaded'
            ) {
              overloads += 1
            } else {
              unexpected.push(error)
            }
          }
        )
      )
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(overloads).toBeGreaterThan(0)
      } finally {
        wait.release()
        await Promise.all(pending)
      }
      expect(unexpected).toEqual([])
      await expect(invoke('files.write', { content: 'after drain' })).resolves.toBeDefined()
    }
  )
})
