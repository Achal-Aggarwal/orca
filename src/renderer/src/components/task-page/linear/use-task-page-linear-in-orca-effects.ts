import { observeLinearIssueRead } from '@/store/slices/linear/linear-issue-publication'
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
    const read = readLinkedLinearIssuesWithLimit(linkedRefs, (ref) => {
      const fetch = forceRefresh ? refreshLinearIssue : fetchLinearIssue
      return fetch(ref.identifier, ref.workspaceId ?? selectedLinearWorkspaceId, {
        sourceContext: ref.sourceContext ?? linearTaskSourceContext
      })
    })
    const release = observeLinearIssueRead(
      read,
      () =>
        !cancelled &&
        isCurrentLinearRequest(lastLinearRequestRef, requestSignature, linearRefreshNonce),
      (lease, view) => {
        if (view.kind === 'abandoned') {
          setLinearLoading((previous) =>
            !cancelled &&
            isCurrentLinearRequest(lastLinearRequestRef, requestSignature, linearRefreshNonce)
              ? false
              : previous
          )
          return
        }
        if (view.data) {
          setLinearIssues((current) =>
            lease.commit(view, current, (_, results) =>
              filterLinearIssuesForInOrcaWorkspace(
                (results ?? []).filter((issue): issue is LinearIssue => issue !== null),
                selectedLinearWorkspaceId
              )
            )
          )
        }
        if (view.kind === 'data') {
          setLinearError((current) =>
            lease.commit(view, current, (_, results) => {
              const loaded = results?.filter(Boolean).length ?? 0
              if (loaded === 0) {
                return translate(
                  'auto.components.TaskPage.linearHasWorktreeLoadFailed',
                  'Unable to load Linear issues linked to an Orca workspace.'
                )
              }
              return loaded === results?.length
                ? null
                : translate(
                    'auto.components.TaskPage.linearHasWorktreePartialLoadFailed',
                    'Some Linear issues linked to an Orca workspace could not be loaded. Refresh to try again.'
                  )
            })
          )
        }
        setLinearLoading((current) => lease.commit(view, current, () => view.kind === 'loading'))
      }
    )
    return () => {
      cancelled = true
      release()
    }
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
