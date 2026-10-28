import { afterEach, expect, it, vi } from 'vitest'
import {
  blobUrlCache,
  cacheLocalImageBlob,
  invalidateLocalImageCache,
  hasLocalImageCacheCapacity,
  isLocalImageCacheCapacityBlocked,
  subscribeToLocalImageCacheCapacity,
  pinLocalImageCache,
  releaseLocalImageBlob,
  resetLocalImageCacheState,
  unpinLocalImageCache
} from './local-image-src-cache'

afterEach(() => {
  resetLocalImageCacheState()
  vi.restoreAllMocks()
})

it.each(['forward', 'reverse', 'shared'])(
  'avoids cache scans while admitting and closing %s image leases',
  (order) => {
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const cacheKeys = vi.spyOn(blobUrlCache, 'keys')
    const mapValues = vi.spyOn(Map.prototype, 'values')
    let admitted = 0
    for (let index = 0; index < 100; index += 1) {
      const key = `image-${index}`
      pinLocalImageCache(key)
      if (order === 'shared') {
        pinLocalImageCache(key)
      }
      admitted += Number(cacheLocalImageBlob(key, `blob:${key}`, 68))
    }
    for (let index = 0; index < 100; index += 1) {
      unpinLocalImageCache(`image-${order === 'forward' ? index : 99 - index}`)
    }
    if (order === 'shared') {
      for (let index = 0; index < 100; index += 1) {
        unpinLocalImageCache(`image-${index}`)
      }
    }
    const keyScans = cacheKeys.mock.calls.length
    const byteScans = mapValues.mock.calls.length
    cacheKeys.mockRestore()
    mapValues.mockRestore()
    expect(admitted).toBe(100)
    expect(blobUrlCache.size).toBe(100)
    expect({ keyScans, byteScans }).toEqual({ keyScans: 0, byteScans: 0 })
  }
)

it('preserves byte admission and oldest eligible eviction through replacements and release', () => {
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const halfBudget = 64 * 1024 * 1024
  expect(cacheLocalImageBlob('first', 'blob:first', halfBudget)).toBe(true)
  expect(cacheLocalImageBlob('second', 'blob:second', halfBudget)).toBe(true)
  pinLocalImageCache('first')
  expect(cacheLocalImageBlob('first', 'blob:first-smaller', halfBudget / 2)).toBe(true)
  expect(cacheLocalImageBlob('third', 'blob:third', halfBudget / 2)).toBe(true)
  expect(Array.from(blobUrlCache.keys())).toEqual(['first', 'second', 'third'])
  expect(cacheLocalImageBlob('third', 'blob:third-larger', halfBudget)).toBe(true)
  expect(Array.from(blobUrlCache.keys())).toEqual(['first', 'third'])
  pinLocalImageCache('third')
  expect(cacheLocalImageBlob('first', 'blob:too-large', halfBudget + 1)).toBe(false)
  expect(blobUrlCache.get('first')).toBe('blob:first-smaller')
  unpinLocalImageCache('third')
  releaseLocalImageBlob('third')
  expect(cacheLocalImageBlob('fourth', 'blob:fourth', halfBudget)).toBe(true)
  unpinLocalImageCache('first')
  invalidateLocalImageCache()
  expect(cacheLocalImageBlob('full', 'blob:full', halfBudget * 2)).toBe(true)
  expect(cacheLocalImageBlob('next', 'blob:next', 1)).toBe(true)
  expect(Array.from(blobUrlCache.keys())).toEqual(['next'])
})

it('notifies capacity waiters once after a final owner releases enough encoded bytes', async () => {
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const half = 64 * 1024 * 1024
  for (const key of ['first', 'second', 'waiting']) {
    pinLocalImageCache(key)
  }
  pinLocalImageCache('first')
  expect(cacheLocalImageBlob('first', 'blob:first', half)).toBe(true)
  expect(cacheLocalImageBlob('second', 'blob:second', half)).toBe(true)
  expect(cacheLocalImageBlob('waiting', 'blob:waiting', half)).toBe(false)
  expect(isLocalImageCacheCapacityBlocked('waiting')).toBe(true)
  expect(hasLocalImageCacheCapacity('waiting')).toBe(false)
  const listener = vi.fn()
  const unsubscribe = subscribeToLocalImageCacheCapacity(listener)
  unpinLocalImageCache('first')
  await Promise.resolve()
  expect(listener).not.toHaveBeenCalled()
  expect(hasLocalImageCacheCapacity('waiting')).toBe(false)
  unpinLocalImageCache('first')
  releaseLocalImageBlob('first')
  await Promise.resolve()
  expect(listener).toHaveBeenCalledOnce()
  expect(hasLocalImageCacheCapacity('waiting')).toBe(true)
  expect(cacheLocalImageBlob('waiting', 'blob:admitted', half)).toBe(true)
  expect(isLocalImageCacheCapacityBlocked('waiting')).toBe(false)
  unsubscribe()
})

it('clears refusal ownership on final unpin and ignores a permanently oversized image', () => {
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  pinLocalImageCache('full')
  pinLocalImageCache('waiting')
  expect(cacheLocalImageBlob('full', 'blob:full', 128 * 1024 * 1024)).toBe(true)
  expect(cacheLocalImageBlob('waiting', 'blob:waiting', 1)).toBe(false)
  unpinLocalImageCache('waiting')
  expect(isLocalImageCacheCapacityBlocked('waiting')).toBe(false)
  pinLocalImageCache('oversized')
  expect(cacheLocalImageBlob('oversized', 'blob:oversized', 128 * 1024 * 1024 + 1)).toBe(false)
  expect(isLocalImageCacheCapacityBlocked('oversized')).toBe(false)
})
