import {
  hasUntrackedLocalImageCachePin,
  isLocalImageCacheKeyPinned
} from './local-image-cache-pinning'

type RetiredImage = { key: string; deadline: number }
const displayedUrls = new Map<string, number>()
const retiredUrls = new Map<string, RetiredImage>()
const retiredKeys = new Map<string, Set<string>>()
const queuedUrls = new Set<string>()
const pendingReleases = new Map<string, number>()
let cleanupPending = false
let stateVersion = 0
let fallbackTimer: ReturnType<typeof setTimeout> | undefined
let fallbackDeadline = 0

function revokeRetiredUrl(url: string, retired: RetiredImage): void {
  retiredUrls.delete(url)
  const urls = retiredKeys.get(retired.key)
  urls?.delete(url)
  if (urls?.size === 0) {
    retiredKeys.delete(retired.key)
  }
  URL.revokeObjectURL(url)
  if (retiredUrls.size === 0 && fallbackTimer !== undefined) {
    clearTimeout(fallbackTimer)
    fallbackTimer = undefined
  }
}

function scheduleFallback(deadline: number): void {
  if (fallbackTimer !== undefined && fallbackDeadline <= deadline) {
    return
  }
  if (fallbackTimer !== undefined) {
    clearTimeout(fallbackTimer)
  }
  fallbackDeadline = deadline
  fallbackTimer = setTimeout(
    () => {
      fallbackTimer = undefined
      for (const url of retiredUrls.keys()) {
        queueRetiredCleanup(url)
      }
    },
    Math.max(0, deadline - Date.now())
  )
}

function queueRetiredCleanup(url: string): void {
  queuedUrls.add(url)
  if (cleanupPending) {
    return
  }
  cleanupPending = true
  const version = stateVersion
  queueMicrotask(() => {
    if (version !== stateVersion) {
      return
    }
    cleanupPending = false
    for (const [releasedUrl, count] of pendingReleases) {
      const remaining = (displayedUrls.get(releasedUrl) ?? 0) - count
      if (remaining > 0) {
        displayedUrls.set(releasedUrl, remaining)
      } else {
        displayedUrls.delete(releasedUrl)
      }
    }
    pendingReleases.clear()
    const urls = [...queuedUrls]
    queuedUrls.clear()
    for (const candidate of urls) {
      const retired = retiredUrls.get(candidate)
      if (!retired || displayedUrls.has(candidate)) {
        continue
      }
      if (!hasUntrackedLocalImageCachePin(retired.key) || retired.deadline <= Date.now()) {
        revokeRetiredUrl(candidate, retired)
      } else {
        scheduleFallback(retired.deadline)
      }
    }
  })
}

export function getLocalImageBlobLifetimeVersion(): number {
  return stateVersion
}

export function retainLocalImageBlobUrl(url: string): () => void {
  displayedUrls.set(url, (displayedUrls.get(url) ?? 0) + 1)
  const version = stateVersion
  let released = false
  return () => {
    if (released || version !== stateVersion) {
      return
    }
    released = true
    pendingReleases.set(url, (pendingReleases.get(url) ?? 0) + 1)
    queueRetiredCleanup(url)
  }
}

export function retireLocalImageBlobUrls(entries: [string, string][]): void {
  for (const [key, url] of entries) {
    if (!retiredUrls.has(url)) {
      retiredUrls.set(url, { key, deadline: Date.now() + 30_000 })
      const urls = retiredKeys.get(key) ?? new Set<string>()
      urls.add(url)
      retiredKeys.set(key, urls)
    }
    queueRetiredCleanup(url)
  }
}

export function releaseLocalImageBlobUrl(key: string, url: string): void {
  if (displayedUrls.has(url) || isLocalImageCacheKeyPinned(key)) {
    retireLocalImageBlobUrls([[key, url]])
  } else {
    URL.revokeObjectURL(url)
  }
}

export function releaseRetiredLocalImageBlobUrls(key: string): void {
  for (const url of retiredKeys.get(key) ?? []) {
    queueRetiredCleanup(url)
  }
}

export function resetLocalImageBlobLifetimes(): void {
  stateVersion += 1
  if (fallbackTimer !== undefined) {
    clearTimeout(fallbackTimer)
    fallbackTimer = undefined
  }
  for (const url of retiredUrls.keys()) {
    URL.revokeObjectURL(url)
  }
  displayedUrls.clear()
  retiredUrls.clear()
  retiredKeys.clear()
  queuedUrls.clear()
  pendingReleases.clear()
  cleanupPending = false
}
