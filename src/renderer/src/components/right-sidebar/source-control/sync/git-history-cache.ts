import type { GitHistoryPanelState } from './git-history-panel'

export const MAX_INACTIVE_GIT_HISTORY_ENTRIES = 4
export const MAX_INACTIVE_GIT_HISTORY_BYTES = 4 * 1024 * 1024

export type GitHistoryCacheEntry = {
  ownerKey: string
  requestId: number
  state: GitHistoryPanelState
  stringBytes: number
}
export type GitHistoryCache = ReadonlyMap<string, GitHistoryCacheEntry>

function retainedStringBytes(value: unknown): number {
  if (typeof value === 'string') {
    return value.length * 2
  }
  if (!value || typeof value !== 'object') {
    return 0
  }
  const values = Array.isArray(value) ? value : Object.values(value)
  return values.reduce((bytes: number, item: unknown) => bytes + retainedStringBytes(item), 0)
}

export function pruneGitHistoryCache(
  cache: GitHistoryCache,
  activeWorktreeId: string | null,
  worktreeMap?: ReadonlyMap<string, unknown>
): GitHistoryCache {
  let inactiveEntries = 0
  let inactiveBytes = 0
  const next = new Map(cache)
  for (const [id, entry] of next) {
    if (
      (worktreeMap && !worktreeMap.has(id)) ||
      (id !== activeWorktreeId && entry.stringBytes > MAX_INACTIVE_GIT_HISTORY_BYTES)
    ) {
      next.delete(id)
    } else if (id !== activeWorktreeId) {
      inactiveEntries++
      inactiveBytes += entry.stringBytes
    }
  }
  for (const [id, entry] of next) {
    if (
      inactiveEntries <= MAX_INACTIVE_GIT_HISTORY_ENTRIES &&
      inactiveBytes <= MAX_INACTIVE_GIT_HISTORY_BYTES
    ) {
      break
    }
    if (id !== activeWorktreeId) {
      next.delete(id)
      inactiveEntries--
      inactiveBytes -= entry.stringBytes
    }
  }
  return next.size === cache.size ? cache : next
}

export function cacheGitHistoryState(
  cache: GitHistoryCache,
  worktreeId: string,
  ownerKey: string,
  requestId: number,
  state: GitHistoryPanelState,
  activeWorktreeId: string | null
): GitHistoryCache {
  const next = new Map(cache)
  next.delete(worktreeId)
  // Charge every retained string conservatively as UTF-16, including authors, refs, and errors.
  next.set(worktreeId, {
    ownerKey,
    requestId,
    state,
    stringBytes: retainedStringBytes(state) + 2 * (ownerKey.length + worktreeId.length)
  })
  return pruneGitHistoryCache(next, activeWorktreeId)
}
