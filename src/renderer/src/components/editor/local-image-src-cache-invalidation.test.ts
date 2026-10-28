import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cacheLocalImageBlob,
  invalidateLocalImageCache,
  pinLocalImageCache,
  resetLocalImageCacheState,
  unpinLocalImageCache
} from './local-image-src-cache'

const IMAGE_BYTES = 4 * 1024 * 1024
const liveUrls = new Map<string, number>()

beforeEach(() => {
  vi.useFakeTimers()
  const revoke = URL.revokeObjectURL.bind(URL)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    liveUrls.delete(url)
    revoke(url)
  })
})

afterEach(() => {
  resetLocalImageCacheState()
  for (const url of liveUrls.keys()) {
    URL.revokeObjectURL(url)
  }
  liveUrls.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function cacheImage(key: string): string {
  const blob = new Blob([new Uint8Array(IMAGE_BYTES)], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  liveUrls.set(url, blob.size)
  expect(cacheLocalImageBlob(key, url, blob.size)).toBe(true)
  return url
}

describe('invalidated local image URL ownership', () => {
  it.each([3, 10])(
    'releases %i closed image previews without accumulating a revocation grace pool',
    (cycles) => {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const key = `closed:${cycle}`
        cacheImage(key)
        pinLocalImageCache(key)
        unpinLocalImageCache(key)
        invalidateLocalImageCache()
      }
      const retainedBlobBytes = Array.from(liveUrls.values()).reduce((sum, bytes) => sum + bytes, 0)
      console.info(
        'CLOSED_IMAGE_INVALIDATION_RETENTION',
        JSON.stringify({ cycles, retainedBlobBytes })
      )
      expect(retainedBlobBytes).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('releases an unleased prewarm while preserving the grace period for a displayed image', () => {
    const visible = cacheImage('visible')
    const prewarm = cacheImage('prewarm')
    pinLocalImageCache('visible')
    invalidateLocalImageCache()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(prewarm)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(visible)
    vi.advanceTimersByTime(29_999)
    expect(liveUrls.has(visible)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(liveUrls.has(visible)).toBe(false)
  })

  it('keeps a lease shared by two displays until both close', () => {
    const visible = cacheImage('shared')
    pinLocalImageCache('shared')
    pinLocalImageCache('shared')
    unpinLocalImageCache('shared')
    invalidateLocalImageCache()
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(visible)
    unpinLocalImageCache('shared')
    vi.advanceTimersByTime(30_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(visible)
  })
})
