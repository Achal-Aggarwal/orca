import {
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
const pendingBlobUrlRevocations = new Map<string, Set<string>>()
let pendingBlobUrlRevocationTimer: ReturnType<typeof setTimeout> | null = null

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
  }
  retainedBytes -= blobUrlCacheBytes.get(key) ?? 0
  blobUrlCacheBytes.delete(key)
  if (url) {
    URL.revokeObjectURL(url)
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
  if (
    (expectedVersion !== undefined && getLocalImageCacheKeyVersion(key) !== expectedVersion) ||
    byteLength > BLOB_URL_CACHE_MAX_BYTES
  ) {
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
    URL.revokeObjectURL(previousUrl)
  }
  retainedBytes += byteLength - previousBytes
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

export function pinLocalImageCache(key: string): void {
  const wasPinned = isLocalImageCacheKeyPinned(key)
  pinLocalImageCacheKey(key)
  if (!wasPinned && blobUrlCache.has(key)) {
    pinnedCacheEntries += 1
  }
}

export function unpinLocalImageCache(key: string): void {
  const wasPinned = isLocalImageCacheKeyPinned(key)
  unpinLocalImageCacheKey(key)
  if (wasPinned && !isLocalImageCacheKeyPinned(key) && blobUrlCache.has(key)) {
    pinnedCacheEntries -= 1
  }
  releaseUnpinnedPendingBlobUrls(key)
  pruneImageCache(key)
  cleanupLocalImageCacheKeyVersion(key)
}

export function subscribeToLocalImageCacheInvalidation(listener: () => void): () => void {
  cacheListeners.add(listener)
  return () => cacheListeners.delete(listener)
}

function revokePendingBlobUrls(): void {
  pendingBlobUrlRevocationTimer = null
  for (const urls of pendingBlobUrlRevocations.values()) {
    for (const url of urls) {
      URL.revokeObjectURL(url)
    }
  }
  pendingBlobUrlRevocations.clear()
}

function releaseUnpinnedPendingBlobUrls(key: string): void {
  const urls = pendingBlobUrlRevocations.get(key)
  if (!urls || isLocalImageCacheKeyPinned(key)) {
    return
  }
  // Reloads synchronously release and reacquire their key while the old image remains displayed.
  queueMicrotask(() => {
    if (pendingBlobUrlRevocations.get(key) !== urls || isLocalImageCacheKeyPinned(key)) {
      return
    }
    pendingBlobUrlRevocations.delete(key)
    for (const url of urls) {
      URL.revokeObjectURL(url)
    }
    if (pendingBlobUrlRevocations.size === 0 && pendingBlobUrlRevocationTimer !== null) {
      clearTimeout(pendingBlobUrlRevocationTimer)
      pendingBlobUrlRevocationTimer = null
    }
  })
}

function scheduleBlobUrlRevocation(entries: [string, string][]): void {
  for (const [key, url] of entries) {
    const urls = pendingBlobUrlRevocations.get(key) ?? new Set<string>()
    urls.add(url)
    pendingBlobUrlRevocations.set(key, urls)
    releaseUnpinnedPendingBlobUrls(key)
  }
  if (pendingBlobUrlRevocationTimer !== null || pendingBlobUrlRevocations.size === 0) {
    return
  }
  pendingBlobUrlRevocationTimer = setTimeout(revokePendingBlobUrls, 30_000)
}

export function invalidateLocalImageCache(): void {
  const staleUrls: [string, string][] = []
  for (const [key, url] of blobUrlCache) {
    if (isLocalImageCacheKeyPinned(key)) {
      staleUrls.push([key, url])
    } else {
      URL.revokeObjectURL(url)
    }
  }
  blobUrlCache.clear()
  blobUrlCacheBytes.clear()
  retainedBytes = 0
  pinnedCacheEntries = 0
  inFlightBlobUrlLoads.clear()
  cacheKeyVersions.clear()
  cacheGeneration += 1
  for (const listener of cacheListeners) {
    listener()
  }
  if (staleUrls.length > 0) {
    scheduleBlobUrlRevocation(staleUrls)
  }
}

export function releaseLocalImageBlob(key: string): void {
  if (isLocalImageCacheKeyPinned(key)) {
    return
  }
  cacheKeyVersions.set(key, getLocalImageCacheKeyVersion(key) + 1)
  const inFlight = inFlightBlobUrlLoads.get(key)
  if (inFlight) {
    // Released reads can resolve null or stale and must not be reused by the next visible lease.
    inFlightBlobUrlLoads.delete(key)
  }
  const url = blobUrlCache.get(key)
  if (url) {
    deleteCachedImage(key)
  }
  if (!inFlight) {
    cleanupLocalImageCacheKeyVersion(key)
  }
}

export function resetLocalImageCacheState(): void {
  if (pendingBlobUrlRevocationTimer !== null) {
    clearTimeout(pendingBlobUrlRevocationTimer)
    pendingBlobUrlRevocationTimer = null
  }
  revokePendingBlobUrls()
  for (const url of blobUrlCache.values()) {
    URL.revokeObjectURL(url)
  }
  blobUrlCache.clear()
  blobUrlCacheBytes.clear()
  retainedBytes = 0
  pinnedCacheEntries = 0
  clearLocalImageCachePins()
  inFlightBlobUrlLoads.clear()
  cacheKeyVersions.clear()
  cacheGeneration = 0
  pendingBlobUrlRevocations.clear()
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
