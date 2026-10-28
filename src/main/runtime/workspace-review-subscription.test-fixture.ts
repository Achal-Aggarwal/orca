import { vi } from 'vitest'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { WorkspaceReviewTarget } from './runtime-workspace-review-target'
import { WorktreeReviewStatusSchema } from '../../shared/worktree-review-status'
import { makeCandidate } from '../github/pr-refresh-coordinator-test-harness'
import { RuntimeSubscriptionRegistry } from './runtime-subscription-registry'

export async function harness() {
  const { WorkspaceReviewSubscription } = await import('./workspace-review-subscription')
  const coordinator = await import('../github/pr-refresh-coordinator')
  let cache: PersistedState['githubCache'] = { pr: {}, issue: {} }
  let candidate = makeCandidate({
    currentHeadOid: 'head-sha',
    isSelected: true,
    connectionId: null,
    executionHostId: 'local'
  })
  const registry = new RuntimeSubscriptionRegistry()
  const cleanups = new Map<string, () => void>()
  const frames: unknown[] = []
  const prepare = vi.fn(async (): Promise<WorkspaceReviewTarget> => {
    const cached = cache.pr[candidate.cacheKey]
    return {
      worktreeId: 'wt-1',
      branch: candidate.branch,
      candidate: {
        ...candidate,
        cachedFetchedAt: cached?.fetchedAt ?? null,
        cachedHeadOid: cached?.fetchedHeadOid,
        cachedHasPR: cached ? cached.data !== null : null,
        cachedPRState: cached?.data?.state,
        cachedChecksStatus: cached?.data?.checksStatus
      }
    }
  })
  const runtime = {
    prepareWorkspaceReviewRefresh: prepare,
    requireStore: () => ({
      getGitHubCache: () => cache,
      setGitHubCache: (next: PersistedState['githubCache']) => {
        cache = next
      }
    }),
    registerSubscriptionCleanup: (id: string, cleanup: () => void, connectionId?: string) => {
      cleanups.set(id, cleanup)
      registry.register(
        id,
        () => {
          cleanups.delete(id)
          cleanup()
        },
        connectionId
      )
    },
    cleanupSubscription: registry.cleanup.bind(registry)
  }
  const open = (
    id = 'mobile-1',
    signal?: AbortSignal,
    emit = (frame: unknown): void => {
      frames.push(frame)
    }
  ) => {
    return new WorkspaceReviewSubscription(
      runtime,
      id,
      'id:wt-1',
      'mobile-socket',
      emit,
      () => {},
      signal
    )
  }

  return {
    coordinator,
    runtime,
    registry,
    frames,
    open,
    prepare,
    cleanups,
    get candidate() {
      return candidate
    },
    set candidate(value) {
      candidate = value
    },
    get cache() {
      return cache
    },
    set cache(value) {
      cache = value
    }
  }
}

export function snapshots(frames: unknown[]) {
  return frames.flatMap((frame) => {
    const parsed = WorktreeReviewStatusSchema.safeParse(frame)
    return parsed.success ? [parsed.data] : []
  })
}
