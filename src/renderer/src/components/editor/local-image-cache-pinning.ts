const pinnedKeys = new Map<string, number>()

export function pinLocalImageCacheKey(key: string): void {
  pinnedKeys.set(key, (pinnedKeys.get(key) ?? 0) + 1)
}

export function unpinLocalImageCacheKey(key: string): void {
  const count = pinnedKeys.get(key)
  if (!count || count <= 1) {
    pinnedKeys.delete(key)
    return
  }
  pinnedKeys.set(key, count - 1)
}

export function isLocalImageCacheKeyPinned(key: string): boolean {
  return pinnedKeys.has(key)
}

export function clearLocalImageCachePins(): void {
  pinnedKeys.clear()
}
