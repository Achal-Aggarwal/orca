import {
  releaseLocalImageBlobUrl,
  releaseRetiredLocalImageBlobUrls,
  resetLocalImageBlobLifetimes
} from './local-image-blob-lifetimes'
import {
  notifyLocalImageCacheCapacity,
  resetLocalImageCacheCapacityEvents
} from './local-image-cache-capacity-events'
export { subscribeToLocalImageCacheCapacity } from './local-image-cache-capacity-events'
import {
  type LocalImageCachePinKind,
  clearLocalImageCachePins,
  isLocalImageCacheKeyPinned,
  pinLocalImageCacheKey,
  unpinLocalImageCacheKey
} from './local-image-cache-pinning'

const BLOB_URL_CACHE_MAX_SIZE = 100
// Bound current encoded Blob payloads separately from retired URLs and decoded image memory.
const BLOB_URL_CACHE_MAX_BYTES = 128 * 1024 * 1024

export const blobUrlCache = new Map<string, string>()
const blobUrlCacheBytes = new Map<string, number>()
let retainedBytes = 0
let pinnedCacheEntries = 0
let pinnedBytes = 0
export const inFlightBlobUrlLoads = new Map<string, Promise<string | null>>()
// Invalidate late reads on release so they cannot repopulate an unused cache entry.
const cacheKeyVersions = new Map<string, number>()

export function getLocalImageCacheKeyVersion(key: string): number {
  return cacheKeyVersions.get(key) ?? 0
}

export function cleanupLocalImageCacheKeyVersion(key: string): void {
  if (
    !blobUrlCache.has(key) &&
    !inFlightBlobUrlLoads.has(key) &&
    !isLocalImageCacheKeyPinned(key)
  ) {
    cacheKeyVersions.delete(key)
  }
}

let cacheGeneration = 0
const cacheListeners = new Set<() => void>()
const capacityBlockedKeys = new Map<string, number>()

export function hasLocalImageCacheCapacity(key: string): boolean {
  const blockedBytes = capacityBlockedKeys.get(key)
  return (
    blockedBytes !== undefined &&
    pinnedBytes - (blobUrlCacheBytes.get(key) ?? 0) + blockedBytes <= BLOB_URL_CACHE_MAX_BYTES
  )
}

export function isLocalImageCacheCapacityBlocked(key: string): boolean {
  return capacityBlockedKeys.has(key)
}

function oldestUnpinnedCacheKey(excludedKey?: string, releasedKey?: string): string | undefined {
  const excludedUnpinned =
    excludedKey !== undefined &&
    blobUrlCache.has(excludedKey) &&
    !isLocalImageCacheKeyPinned(excludedKey)
      ? 1
      : 0
  const eligibleEntries = blobUrlCache.size - pinnedCacheEntries - excludedUnpinned
  if (eligibleEntries === 0) {
    return undefined
  }
  if (
    eligibleEntries === 1 &&
    releasedKey !== undefined &&
    releasedKey !== excludedKey &&
    blobUrlCache.has(releasedKey) &&
    !isLocalImageCacheKeyPinned(releasedKey)
  ) {
    return releasedKey
  }
  for (const key of blobUrlCache.keys()) {
    if (key !== excludedKey && !isLocalImageCacheKeyPinned(key)) {
      return key
    }
  }
  return undefined
}

function deleteCachedImage(key: string): void {
  const url = blobUrlCache.get(key)
  if (blobUrlCache.delete(key) && isLocalImageCacheKeyPinned(key)) {
    pinnedCacheEntries -= 1
    pinnedBytes -= blobUrlCacheBytes.get(key) ?? 0
  }
  retainedBytes -= blobUrlCacheBytes.get(key) ?? 0
  blobUrlCacheBytes.delete(key)
  if (url) {
    releaseLocalImageBlobUrl(key, url)
  }
}

function pruneImageCache(releasedKey?: string): void {
  while (blobUrlCache.size > BLOB_URL_CACHE_MAX_SIZE || retainedBytes > BLOB_URL_CACHE_MAX_BYTES) {
    const key = oldestUnpinnedCacheKey(undefined, releasedKey)
    if (key === undefined) {
      return
    }
    deleteCachedImage(key)
    cleanupLocalImageCacheKeyVersion(key)
  }
}

export function cacheLocalImageBlob(
  key: string,
  url: string,
  byteLength: number,
  expectedVersion?: number
): boolean {
  if (expectedVersion !== undefined && getLocalImageCacheKeyVersion(key) !== expectedVersion) {
    URL.revokeObjectURL(url)
    cleanupLocalImageCacheKeyVersion(key)
    return false
  }
  capacityBlockedKeys.delete(key)
  if (byteLength > BLOB_URL_CACHE_MAX_BYTES) {
    URL.revokeObjectURL(url)
    cleanupLocalImageCacheKeyVersion(key)
    return false
  }
  const previousUrl = blobUrlCache.get(key)
  const previousBytes = blobUrlCacheBytes.get(key) ?? 0
  let projectedEntries = blobUrlCache.size + (previousUrl === undefined ? 1 : 0)
  let projectedBytes = retainedBytes - previousBytes + byteLength

  // Active displays share the strict byte budget; the entry target bounds reusable, unleased images.
  while (projectedEntries > BLOB_URL_CACHE_MAX_SIZE || projectedBytes > BLOB_URL_CACHE_MAX_BYTES) {
    const candidate = oldestUnpinnedCacheKey(key)
    if (candidate === undefined) {
      if (isLocalImageCacheKeyPinned(key) && projectedBytes <= BLOB_URL_CACHE_MAX_BYTES) {
        break
      }
      if (isLocalImageCacheKeyPinned(key)) {
        capacityBlockedKeys.set(key, byteLength)
      }
      URL.revokeObjectURL(url)
      cleanupLocalImageCacheKeyVersion(key)
      return false
    }
    const candidateBytes = blobUrlCacheBytes.get(candidate) ?? 0
    deleteCachedImage(candidate)
    projectedEntries -= 1
    projectedBytes -= candidateBytes
    cleanupLocalImageCacheKeyVersion(candidate)
  }
  if (previousUrl !== undefined && previousUrl !== url) {
    releaseLocalImageBlobUrl(key, previousUrl)
  }
  retainedBytes += byteLength - previousBytes
  if (isLocalImageCacheKeyPinned(key)) {
    pinnedBytes += byteLength - previousBytes
  }
  if (previousUrl === undefined && isLocalImageCacheKeyPinned(key)) {
    pinnedCacheEntries += 1
  }
  blobUrlCacheBytes.delete(key)
  blobUrlCacheBytes.set(key, byteLength)
  blobUrlCache.set(key, url)
  return true
}

export function getLocalImageCacheGeneration(): number {
  return cacheGeneration
}

export function pinLocalImageCache(key: string, kind: LocalImageCachePinKind = 'key'): void {
  const wasPinned = isLocalImageCacheKeyPinned(key)
  pinLocalImageCacheKey(key, kind)
  if (!wasPinned && blobUrlCache.has(key)) {
    pinnedCacheEntries += 1
    pinnedBytes += blobUrlCacheBytes.get(key) ?? 0
  }
}

export function unpinLocalImageCache(key: string, kind: LocalImageCachePinKind = 'key'): void {
  const wasPinned = isLocalImageCacheKeyPinned(key)
  unpinLocalImageCacheKey(key, kind)
  if (wasPinned && !isLocalImageCacheKeyPinned(key) && blobUrlCache.has(key)) {
    pinnedCacheEntries -= 1
    pinnedBytes -= blobUrlCacheBytes.get(key) ?? 0
    notifyLocalImageCacheCapacity()
  }
  if (!isLocalImageCacheKeyPinned(key)) {
    capacityBlockedKeys.delete(key)
  }
  releaseRetiredLocalImageBlobUrls(key)
  pruneImageCache(key)
  cleanupLocalImageCacheKeyVersion(key)
}

export function subscribeToLocalImageCacheInvalidation(listener: () => void): () => void {
  cacheListeners.add(listener)
  return () => cacheListeners.delete(listener)
}

export function invalidateLocalImageCache(): void {
  for (const [key, url] of blobUrlCache) {
    releaseLocalImageBlobUrl(key, url)
  }
  blobUrlCache.clear()
  blobUrlCacheBytes.clear()
  retainedBytes = 0
  pinnedCacheEntries = 0
  pinnedBytes = 0
  capacityBlockedKeys.clear()
  inFlightBlobUrlLoads.clear()
  cacheKeyVersions.clear()
  cacheGeneration += 1
  for (const listener of cacheListeners) {
    listener()
  }
}

export function releaseLocalImageBlob(key: string): void {
  if (isLocalImageCacheKeyPinned(key)) {
    return
  }
  capacityBlockedKeys.delete(key)
  cacheKeyVersions.set(key, getLocalImageCacheKeyVersion(key) + 1)
  const inFlight = inFlightBlobUrlLoads.get(key)
  if (inFlight) {
    // Released reads can resolve null or stale and must not be reused by the next visible lease.
    inFlightBlobUrlLoads.delete(key)
  }
  const url = blobUrlCache.get(key)
  if (url) {
    deleteCachedImage(key)
    notifyLocalImageCacheCapacity()
  }
  if (!inFlight) {
    cleanupLocalImageCacheKeyVersion(key)
  }
}

export function resetLocalImageCacheState(): void {
  resetLocalImageBlobLifetimes()
  for (const url of blobUrlCache.values()) {
    URL.revokeObjectURL(url)
  }
  blobUrlCache.clear()
  blobUrlCacheBytes.clear()
  retainedBytes = 0
  pinnedCacheEntries = 0
  pinnedBytes = 0
  capacityBlockedKeys.clear()
  resetLocalImageCacheCapacityEvents()
  clearLocalImageCachePins()
  inFlightBlobUrlLoads.clear()
  cacheKeyVersions.clear()
  cacheGeneration = 0
  cacheListeners.clear()
}

export function disposeLocalImageCacheState(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', invalidateLocalImageCache)
  }
  resetLocalImageCacheState()
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', invalidateLocalImageCache)
}

if (import.meta !== undefined && import.meta.hot) {
  import.meta.hot.dispose(disposeLocalImageCacheState)
}
