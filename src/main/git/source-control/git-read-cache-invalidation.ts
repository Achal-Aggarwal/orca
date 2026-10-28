import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { GitStatusResult } from '../../../shared/git-status-types'
import { MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES } from '../../../shared/in-flight-promise-dedupe'
import { clearGitStatusLineStatsCache } from '../../../shared/git-status-line-stats-cache'
import { invalidateGitBranchLineTotalInFlight } from '../../../shared/git-branch-line-total'
import { GitStatusReadLeaseOwner } from '../git-status-read-lease-owner'
import { invalidateGitUpstreamStatusReads } from '../upstream'
import { clearSubmodulePathsCache } from './submodule-paths'
import { resolvedUpstreamNameCache } from './resolved-upstream-name-cache'
import { SettledDiffCache } from './settled-diff-cache'

export const gitDiffReadLeaseOwner = new GitStatusReadLeaseOwner<GitDiffResult>(
  MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES,
  30_000
)

/** Settled diff results, valid only while their stamped git state holds. */
export const settledDiffCache = new SettledDiffCache()

export const statusReadLeaseOwner = new GitStatusReadLeaseOwner<GitStatusResult>()

// Clear every read cache so post-mutation calls cannot join stale pre-mutation reads.
export function invalidateGitReadCaches(): void {
  gitDiffReadLeaseOwner.invalidate()
  settledDiffCache.clear()
  statusReadLeaseOwner.invalidate()
  invalidateGitBranchLineTotalInFlight()
  invalidateGitUpstreamStatusReads()
  clearGitStatusLineStatsCache()
  clearSubmodulePathsCache()
  resolvedUpstreamNameCache.clear()
}

export async function runWithGitReadCacheInvalidation<T>(run: () => Promise<T>): Promise<T> {
  invalidateGitReadCaches()
  try {
    return await run()
  } finally {
    // Invalidate again: reads started during the mutation can also be stale.
    invalidateGitReadCaches()
  }
}
