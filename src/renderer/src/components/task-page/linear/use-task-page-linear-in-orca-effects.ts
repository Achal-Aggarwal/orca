import { useAppStore } from '@/store'
import { getLinearReadScope, scopedLinearCacheKey } from '@/store/slices/linear/linear-slice-scope'
import { linearIssueReadError } from '@/lib/linear-read-error'
import type { TaskPageLinearListEffectsModel } from './use-task-page-linear-list-effects'
import { useEffect } from 'react'
import {
  readLinkedLinearIssuesWithLimit,
  filterLinearIssuesForInOrcaWorkspace
} from '@/components/task-page/linear/task-page-linear-in-orca-issues'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { translate } from '@/i18n/i18n'

function isCurrentLinearRequest(
  requestRef: React.RefObject<{ signature: string; nonce: number } | null>,
  signature: string,
  nonce: number
): boolean {
  return requestRef.current?.signature === signature && requestRef.current?.nonce === nonce
}

export function useTaskPageLinearInOrcaEffects(model: TaskPageLinearListEffectsModel) {
  const {
    fetchLinearIssue,
    refreshLinearIssue,
    linearConnected,
    selectedLinearWorkspaceId,
    taskSource,
    linearTaskSourceContext,
    taskResumeApplied,
    linearMode,
    setLinearIssues,
    setLinearIssuesHasMore,
    setLinearLoading,
    setLinearError,
    linearRefreshNonce,
    lastLinearRequestRef,
    inOrcaLinkedLinearRefsSignature,
    inOrcaLinkedLinearRefsRef
  } = model
  // Why: Has Worktree loads Linear tickets linked on local worktrees, not a Linear list/search query.
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear' || linearMode !== 'in-orca' || !linearConnected) {
      return
    }
    let cancelled = false
    const linkedRefs = inOrcaLinkedLinearRefsRef.current
    const requestSignature = `in-orca::${selectedLinearWorkspaceId ?? 'default'}::${inOrcaLinkedLinearRefsSignature}`
    const previousRequest = lastLinearRequestRef.current
    const isNewSignature = previousRequest?.signature !== requestSignature
    const forceRefresh = linearRefreshNonce > 0 && previousRequest?.nonce !== linearRefreshNonce
    lastLinearRequestRef.current = {
      nonce: linearRefreshNonce,
      signature: requestSignature
    }
    setLinearIssuesHasMore(false)
    setLinearError(null)
    if (linkedRefs.length === 0) {
      setLinearIssues([])
      setLinearLoading(false)
      return () => {
        cancelled = true
      }
    }
    if (isNewSignature) {
      setLinearIssues([])
    }
    setLinearLoading(true)
    let unsubscribe = () => {}
    // Explicit refresh must use refreshLinearIssue because fetchLinearIssue serves its TTL cache regardless of force.
    void readLinkedLinearIssuesWithLimit(linkedRefs, (ref) => {
      const read = forceRefresh ? refreshLinearIssue : fetchLinearIssue
      return read(ref.identifier, ref.workspaceId ?? selectedLinearWorkspaceId, {
        sourceContext: ref.sourceContext ?? linearTaskSourceContext
      })
    })
      .then((results) => {
        if (
          cancelled ||
          !isCurrentLinearRequest(lastLinearRequestRef, requestSignature, linearRefreshNonce)
        ) {
          return
        }
        const publish = () =>
          setLinearIssues(
            filterLinearIssuesForInOrcaWorkspace(
              results.filter((issue): issue is LinearIssue => issue != null),
              selectedLinearWorkspaceId
            )
          )
        const updateFromCache = () => {
          const state = useAppStore.getState()
          let changed = false
          linkedRefs.forEach((ref, index) => {
            const scope = getLinearReadScope(
              state.settings,
              ref.sourceContext ?? linearTaskSourceContext
            )
            const key = scopedLinearCacheKey(
              scope,
              `${ref.workspaceId ?? selectedLinearWorkspaceId ?? 'selected'}::${ref.identifier}`
            )
            const issue = state.linearIssueCache[key]?.data
            if (issue && results[index] && issue !== results[index]) {
              results[index] = issue
              changed = true
            }
          })
          if (changed) {
            publish()
          }
        }
        updateFromCache()
        unsubscribe = useAppStore.subscribe((state, previous) => {
          if (state.linearIssueCache !== previous.linearIssueCache) {
            updateFromCache()
          }
        })
        const loaded = results.filter((issue): issue is LinearIssue => issue != null)
        // Reads resolve null on failure; all-null linked results must show failure rather than an unlinked empty state.
        if (loaded.length === 0) {
          setLinearError(
            translate(
              'auto.components.TaskPage.linearHasWorktreeLoadFailed',
              'Unable to load Linear issues linked to an Orca workspace.'
            )
          )
          setLinearIssues([])
          setLinearLoading(false)
          return
        }
        if (loaded.length !== results.length) {
          setLinearError(
            translate(
              'auto.components.TaskPage.linearHasWorktreePartialLoadFailed',
              'Some Linear issues linked to an Orca workspace could not be loaded. Refresh to try again.'
            )
          )
        }
        publish()
        setLinearLoading(false)
      })
      .catch((err) => {
        if (
          cancelled ||
          !isCurrentLinearRequest(lastLinearRequestRef, requestSignature, linearRefreshNonce)
        ) {
          return
        }
        setLinearError(linearIssueReadError(err))
        setLinearLoading(false)
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
    // Depend on link signatures rather than unrelated worktree activity so unchanged tickets are not re-read.
  }, [
    fetchLinearIssue,
    inOrcaLinkedLinearRefsSignature,
    inOrcaLinkedLinearRefsRef,
    lastLinearRequestRef,
    linearConnected,
    linearMode,
    linearRefreshNonce,
    linearTaskSourceContext,
    refreshLinearIssue,
    selectedLinearWorkspaceId,
    setLinearError,
    setLinearIssues,
    setLinearIssuesHasMore,
    setLinearLoading,
    taskResumeApplied,
    taskSource
  ])
  return model
}
export type TaskPageLinearInOrcaEffectsModel = ReturnType<typeof useTaskPageLinearInOrcaEffects>
