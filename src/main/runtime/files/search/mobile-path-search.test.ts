import { describe, expect, it, vi } from 'vitest'
import {
  type RuntimeMobileFilePathInventory,
  RuntimeMobileFilePathSearchCache
} from './mobile-path-search'

describe('RuntimeMobileFilePathSearchCache', () => {
  it('reuses a live entry and evicts the oldest key at capacity', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(2, 100)
    const load = vi.fn(async (path: string) => ({
      paths: [path],
      totalCount: 1,
      truncated: false
    }))

    await cache.get('a', () => load('a'), 0)
    await cache.get('a', () => load('a-again'), 50)
    await cache.get('b', () => load('b'), 50)
    await cache.get('c', () => load('c'), 50)
    await cache.get('a', () => load('a-reloaded'), 50)

    expect(load.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c', 'a-reloaded'])
  })

  it('reloads an unevicted key once its TTL has elapsed', async () => {
    // Isolate TTL expiry from capacity eviction.
    const cache = new RuntimeMobileFilePathSearchCache(2, 100)
    const load = vi.fn(async (path: string) => ({ paths: [path], totalCount: 1, truncated: false }))

    await cache.get('a', () => load('a'), 0)
    await cache.get('a', () => load('a-live'), 50)
    await cache.get('a', () => load('a-expired'), 150)

    expect(load.mock.calls.map((call) => call[0])).toEqual(['a', 'a-expired'])
  })

  it('coalesces concurrent cold loads for the same worktree', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(2, 100)
    let resolveLoad: (value: RuntimeMobileFilePathInventory) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<RuntimeMobileFilePathInventory>((resolve) => {
          resolveLoad = resolve
        })
    )

    const first = cache.get('a', load, 0)
    const second = cache.get('a', load, 0)
    expect(load).toHaveBeenCalledOnce()

    resolveLoad({ paths: ['a'], totalCount: 1, truncated: false })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { paths: ['a'], totalCount: 1, truncated: false },
      { paths: ['a'], totalCount: 1, truncated: false }
    ])
  })

  it('starts the TTL when a slow inventory becomes usable', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const cache = new RuntimeMobileFilePathSearchCache(2, 100)
      let resolveLoad: (value: RuntimeMobileFilePathInventory) => void = () => {}
      const load = vi.fn(
        () =>
          new Promise<RuntimeMobileFilePathInventory>((resolve) => {
            resolveLoad = resolve
          })
      )
      const first = cache.get('slow-ssh', load)
      vi.setSystemTime(200)
      resolveLoad({ paths: ['a'], totalCount: 1, truncated: false })
      await first

      await cache.get('slow-ssh', load)
      expect(load).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts by aggregate path bytes in recently-used order', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(8, 100, 250)
    const loads: string[] = []
    const load = async (key: string) => {
      loads.push(key)
      return { paths: [key.repeat(20)], totalCount: 1, truncated: false }
    }

    await cache.get('a', () => load('a'), 0)
    await cache.get('b', () => load('b'), 0)
    await cache.get('a', () => load('a'), 0)
    await cache.get('c', () => load('c'), 0)
    await cache.get('a', () => load('a'), 0)
    await cache.get('b', () => load('b'), 0)

    expect(loads).toEqual(['a', 'b', 'c', 'b'])
  })

  it('returns an oversized inventory unchanged without caching it or evicting a useful entry', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(8, 100, 100)
    const small = { paths: ['a.ts'], totalCount: 1, truncated: false }
    const oversized = { paths: ['x'.repeat(100)], totalCount: 12, truncated: true }
    const load = vi.fn(async () => oversized)
    await cache.get('small', async () => small, 0)

    expect(await cache.get('large', load, 0)).toBe(oversized)
    expect(await cache.get('large', load, 0)).toBe(oversized)
    expect(load).toHaveBeenCalledTimes(2)
    await expect(
      cache.get(
        'small',
        async () => {
          throw new Error('evicted')
        },
        0
      )
    ).resolves.toMatchObject(small)
  })

  it('shares an oversized in-flight inventory before declining to retain it', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(8, 100, 100)
    const loaded = { paths: ['x'.repeat(100)], totalCount: 1, truncated: false }
    const load = vi.fn(async () => loaded)
    const first = cache.get('a', load, 0)
    const second = cache.get('a', load, 0)
    expect(await first).toBe(loaded)
    expect(await second).toBe(loaded)
    expect(load).toHaveBeenCalledOnce()
    await cache.get('a', load, 0)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('releases expired entry bytes before admitting the next inventory', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const cache = new RuntimeMobileFilePathSearchCache(8, 100, 150)
      const load = async () => ({ paths: ['a.ts'], totalCount: 1, truncated: false })
      await cache.get('expired', load)
      vi.advanceTimersByTime(100)
      await cache.get('b', load)
      await cache.get('c', load)
      await expect(
        cache.get('b', async () => {
          throw new Error('evicted')
        })
      ).resolves.toMatchObject({ paths: ['a.ts'] })
      expect(vi.getTimerCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
