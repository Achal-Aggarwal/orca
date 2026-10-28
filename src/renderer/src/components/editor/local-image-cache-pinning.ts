export type LocalImageCachePinKind = 'key' | 'display'
const pinnedKeys = new Map<string, number>()
const untrackedKeys = new Map<string, number>()

export function pinLocalImageCacheKey(key: string, kind: LocalImageCachePinKind = 'key'): void {
  pinnedKeys.set(key, (pinnedKeys.get(key) ?? 0) + 1)
  if (kind === 'key') {
    untrackedKeys.set(key, (untrackedKeys.get(key) ?? 0) + 1)
  }
}

export function unpinLocalImageCacheKey(key: string, kind: LocalImageCachePinKind = 'key'): void {
  const count = pinnedKeys.get(key)
  if (!count || count <= 1) {
    pinnedKeys.delete(key)
  } else {
    pinnedKeys.set(key, count - 1)
  }
  if (kind === 'key') {
    const untracked = untrackedKeys.get(key) ?? 0
    if (untracked <= 1) {
      untrackedKeys.delete(key)
    } else {
      untrackedKeys.set(key, untracked - 1)
    }
  }
}

export function isLocalImageCacheKeyPinned(key: string): boolean {
  return pinnedKeys.has(key)
}

export function hasUntrackedLocalImageCachePin(key: string): boolean {
  return untrackedKeys.has(key)
}

export function clearLocalImageCachePins(): void {
  pinnedKeys.clear()
  untrackedKeys.clear()
}
