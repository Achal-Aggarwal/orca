import { describe, expect, it } from 'vitest'
import { enqueueMermaidRender } from './mermaid-render-queue'

function gate(): { promise: Promise<void>; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, release: resolve }
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function enqueuePayload(wait: Promise<void>, cancel = false): WeakRef<Uint8Array> {
  const payload = new Uint8Array(4 * 1024 * 1024)
  payload[0] = 19
  const remove = enqueueMermaidRender(async () => {
    await wait
    expect(payload[0]).toBe(19)
  })
  if (cancel) {
    remove()
  }
  return new WeakRef(payload)
}

describe('diagram render queue ownership', () => {
  it('releases cancelled queued inputs while preserving the active render and live successor', async () => {
    const blocker = gate()
    const active = enqueuePayload(blocker.promise)
    const cancelled = Array.from({ length: 8 }, () => enqueuePayload(Promise.resolve(), true))
    const successor = enqueuePayload(Promise.resolve())
    const drained = gate()
    enqueueMermaidRender(async () => drained.release())
    try {
      await collect()
      expect(active.deref()?.[0]).toBe(19)
      expect(successor.deref()?.[0]).toBe(19)
      const retained = cancelled.filter((ref) => ref.deref() !== undefined).length
      console.info(
        'DIAGRAM_CANCELLED_QUEUE_RETENTION',
        JSON.stringify({
          payloads: cancelled.length,
          retained,
          retainedBytes: retained * 4 * 1024 * 1024
        })
      )
      expect(retained).toBe(0)
    } finally {
      blocker.release()
      await drained.promise
    }
    await collect()
    expect(active.deref()).toBeUndefined()
    expect(successor.deref()).toBeUndefined()
  })

  it.each(['resolve', 'reject'] as const)(
    'keeps live diagrams in order after an active render %s and queued cancellation',
    async (outcome) => {
      const blocker = Promise.withResolvers<void>()
      const started: string[] = []
      enqueueMermaidRender(async () => {
        started.push('active')
        await blocker.promise
      })
      const remove = enqueueMermaidRender(async () => {
        started.push('cancelled')
      })
      enqueueMermaidRender(async () => {
        started.push('successor')
      })
      const drained = gate()
      enqueueMermaidRender(async () => {
        started.push('last')
        drained.release()
      })
      remove()
      expect(started).toEqual(['active'])
      if (outcome === 'resolve') {
        blocker.resolve()
      } else {
        blocker.reject(new Error('diagram failed'))
      }
      await drained.promise
      expect(started).toEqual(['active', 'successor', 'last'])
      const resumed = gate()
      enqueueMermaidRender(async () => {
        started.push('resumed')
        resumed.release()
      })
      await resumed.promise
      expect(started).toEqual(['active', 'successor', 'last', 'resumed'])
    }
  )
})
