import { readWorkspaceReviewPR } from '../../shared/sidebar-list/workspace-review-facts'
import {
  shouldClearBranchMismatchedLinkedOpenPR,
  shouldClearDivergedLinkedMergedPR
} from '../../shared/github/linked-pr-staleness'
import type { RuntimeStore } from './runtime-store-contract'
import type { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceReviewTarget } from './runtime-workspace-review-target'
import type { GitHubPRRefreshEvent } from '../../shared/github/pull-request-refresh-types'
import {
  WORKTREE_REVIEW_LEASE_MS,
  type WorktreeReviewStatus
} from '../../shared/worktree-review-status'
import { reviewRefreshIntervalMs } from '../../shared/review-refresh-policy'
import { aliasFromCandidate, sameAliasRequestIdentity } from '../github/pr-refresh-candidate-policy'
import {
  clearVisiblePRRefreshWindow,
  reportVisiblePRRefreshCandidates,
  subscribePRRefreshEvents
} from '../github/pr-refresh-coordinator'

export class WorkspaceReviewSubscription {
  private target?: WorkspaceReviewTarget
  private generation = 0
  private sequence = 0
  private lastError?: string
  private released = false
  private timer?: ReturnType<typeof setTimeout>
  private stopListening = (): void => {}

  constructor(
    private readonly runtime: Pick<
      OrcaRuntimeService,
      'prepareWorkspaceReviewRefresh' | 'cleanupSubscription' | 'registerSubscriptionCleanup'
    > & { requireStore(): Pick<RuntimeStore, 'getGitHubCache' | 'setGitHubCache'> },
    readonly subscriptionId: string,
    private readonly selector: string,
    readonly connectionId: string | undefined,
    private readonly emit: (frame: unknown) => void,
    private readonly onClose: () => void,
    private readonly signal?: AbortSignal
  ) {
    runtime.registerSubscriptionCleanup(subscriptionId, () => this.dispose(), connectionId)
    this.stopListening = subscribePRRefreshEvents((event) => {
      void this.apply(event).catch(() => {
        this.lastError = 'Review status unavailable'
        this.publish('updated')
      })
    })
    if (signal?.aborted) {
      this.close()
    } else {
      signal?.addEventListener('abort', this.close, { once: true })
    }
    this.armExpiry()
  }

  readonly close = (): void => {
    this.runtime.cleanupSubscription(this.subscriptionId)
  }

  private armExpiry(): void {
    if (this.released) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(this.close, WORKTREE_REVIEW_LEASE_MS)
    this.timer.unref?.()
  }

  private send(frame: unknown): void {
    try {
      this.emit(frame)
    } catch {
      this.close()
    }
  }

  private dispose(): void {
    if (this.released) {
      return
    }
    this.released = true
    this.generation += 1
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.signal?.removeEventListener('abort', this.close)
    this.stopListening()
    clearVisiblePRRefreshWindow(this.subscriptionId)
    this.onClose()
    this.send({ type: 'end', subscriptionId: this.subscriptionId })
  }

  async renew(): Promise<boolean> {
    if (this.released) {
      return false
    }
    const version = ++this.generation
    try {
      const next = await this.runtime.prepareWorkspaceReviewRefresh(this.selector)
      if (this.released || version !== this.generation) {
        return false
      }
      const previous = this.target?.candidate
      if (
        previous?.cacheKey !== next.candidate?.cacheKey ||
        previous?.currentHeadOid !== next.candidate?.currentHeadOid
      ) {
        this.lastError = undefined
      }
      this.target = next
      reportVisiblePRRefreshCandidates(
        next.candidate ? [next.candidate] : [],
        version,
        this.subscriptionId
      )
      this.armExpiry()
      this.publish(version === 1 ? 'snapshot' : 'updated')
      return !this.released
    } catch (error) {
      if (version !== this.generation || this.released) {
        return false
      }
      this.close()
      throw error
    }
  }

  private publish(type: WorktreeReviewStatus['type']): void {
    if (this.released || !this.target) {
      return
    }
    const candidate = this.target.candidate
    const cached = candidate
      ? this.runtime.requireStore().getGitHubCache().pr[candidate.cacheKey]
      : undefined
    let pr = candidate
      ? readWorkspaceReviewPR(
          {
            branch: candidate.branch,
            linkedPR: this.target.linkedPR ?? null,
            suppressedGitHubPR: this.target.suppressedGitHubPR
          },
          { id: candidate.repoId, path: candidate.repoPath, connectionId: candidate.connectionId },
          this.runtime.requireStore().getGitHubCache().pr
        )
      : null
    if (
      shouldClearBranchMismatchedLinkedOpenPR({
        pr,
        linkedPRNumber: this.target.linkedPR ?? null,
        branch: this.target.branch,
        requestHeadOid: candidate?.currentHeadOid ?? null,
        pushTargetBranch: this.target.pushTargetBranch ?? null
      }) ||
      shouldClearDivergedLinkedMergedPR({
        pr,
        linkedPRNumber: this.target.linkedPR ?? null,
        requestHeadOid: candidate?.currentHeadOid ?? null
      })
    ) {
      pr = null
    }
    const interval = reviewRefreshIntervalMs({
      state: pr?.state,
      checksStatus: pr?.checksStatus,
      hasReview: cached ? pr != null : null,
      selected: true
    })
    const cachedHead = cached?.fetchedHeadOid ?? pr?.headSha
    const staleHead =
      candidate?.currentHeadOid != null &&
      cachedHead != null &&
      candidate.currentHeadOid !== cachedHead
    this.send({
      type,
      subscriptionId: this.subscriptionId,
      worktreeId: this.target.worktreeId,
      branch: this.target.branch,
      review: pr
        ? {
            number: pr.number,
            state: pr.state,
            checksStatus: pr.checksStatus,
            title: pr.title,
            url: pr.url
          }
        : null,
      fetchedAt: cached?.fetchedAt ?? null,
      stale:
        !!this.lastError ||
        staleHead ||
        (candidate !== null &&
          (!cached || (interval !== null && Date.now() - cached.fetchedAt >= interval))),
      ...(this.lastError ? { error: this.lastError } : {})
    } satisfies WorktreeReviewStatus)
  }

  private async apply(event: GitHubPRRefreshEvent): Promise<void> {
    const candidate = this.target?.candidate
    if (
      this.released ||
      !candidate ||
      event.sequence < this.sequence ||
      !event.aliases.some((alias) => sameAliasRequestIdentity(alias, aliasFromCandidate(candidate)))
    ) {
      return
    }
    if (!event.outcome) {
      if (event.status === 'in-flight') {
        this.sequence = event.sequence
      }
      return
    }
    const version = this.generation
    const current = await this.runtime.prepareWorkspaceReviewRefresh(this.selector)
    if (
      this.released ||
      event.sequence < this.sequence ||
      (this.generation !== version &&
        (!this.target?.candidate ||
          !sameAliasRequestIdentity(
            aliasFromCandidate(this.target.candidate),
            aliasFromCandidate(candidate)
          )))
    ) {
      return
    }
    if (
      !current.candidate ||
      !sameAliasRequestIdentity(
        aliasFromCandidate(current.candidate),
        aliasFromCandidate(candidate)
      )
    ) {
      this.target = current
      this.lastError = undefined
      reportVisiblePRRefreshCandidates(
        current.candidate ? [current.candidate] : [],
        ++this.generation,
        this.subscriptionId
      )
      this.publish('updated')
      return
    }
    this.target = current
    this.sequence = event.sequence
    const outcome = event.outcome
    this.lastError = outcome.kind === 'upstream-error' ? outcome.message : undefined
    if (outcome.kind !== 'upstream-error') {
      const store = this.runtime.requireStore()
      const cache = store.getGitHubCache()
      const existing = cache.pr[candidate.cacheKey]
      if (!existing || existing.fetchedAt <= outcome.fetchedAt) {
        store.setGitHubCache?.({
          ...cache,
          pr: {
            ...cache.pr,
            [candidate.cacheKey]: {
              data: outcome.kind === 'found' ? outcome.pr : null,
              fetchedAt: outcome.fetchedAt,
              fetchedHeadOid: candidate.currentHeadOid
            }
          }
        })
      }
    }
    this.publish('updated')
  }
}
