import { useAppStore } from '@/store'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { observeLinearIssueRead } from '@/store/slices/linear/linear-issue-publication'
import { useLinearIssuePublication } from '@/hooks/useLinearIssuePublication'
import { useCallback, useEffect, useRef, useState } from 'react'

import { createBrowserUuid } from '@/lib/browser-uuid'
import { useMountedRef } from '@/hooks/useMountedRef'
import { linearIssueComments } from '@/runtime/runtime-linear-issue-mutations'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import {
  initLinearIssueEditState,
  type LinearEditState,
  type LinearLocalComment
} from '@/components/LinearItemDrawer'
import type { LinearComment, LinearIssue } from '../../../shared/linear/issue-types'

export function mergeLinearIssueComments(
  fetched: LinearComment[],
  optimistic: LinearComment[]
): LinearComment[] {
  if (optimistic.length === 0) {
    return fetched
  }
  const fetchedIds = new Set(fetched.map((comment) => comment.id))
  return [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
}

export type LinearIssueWorkspaceDetailState = {
  displayed: LinearIssue
  issueLoading: boolean
  comments: LinearComment[]
  commentsLoading: boolean
  commentsError: string | null
  editState: LinearEditState
  handleCommentAdded: (comment: LinearLocalComment) => void
  retryComments: () => Promise<void>
}

export function useLinearIssueWorkspaceDetail({
  issue,
  providerSettings,
  requestKey
}: {
  issue: LinearIssue
  providerSettings: RuntimeLinearSettings
  requestKey: string
}): LinearIssueWorkspaceDetailState {
  const [fullIssue, setFullIssue] = useState<LinearIssue>(issue)
  const [issueLoading, setIssueLoading] = useState(true)
  const [comments, setComments] = useState<LinearComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(true)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [editState, setEditState] = useState<LinearEditState>(() => initLinearIssueEditState(issue))
  const optimisticCommentsRef = useRef<LinearComment[]>([])
  const commentsRequestIdRef = useRef(0)
  const hydrationRequestIdRef = useRef(0)
  const mountedRef = useMountedRef()
  const acceptRead = useLinearIssuePublication(issue, providerSettings, (apply) => {
    setFullIssue((previous) => apply(previous))
    setEditState((previous) => apply(previous))
  })

  const handleCommentAdded = useCallback((comment: LinearLocalComment) => {
    const added: LinearComment = {
      id: comment.id || createBrowserUuid(),
      body: comment.body,
      createdAt: comment.createdAt,
      user: { displayName: 'You' }
    }
    optimisticCommentsRef.current.push(added)
    setComments((current) => [...current, added])
  }, [])

  const loadComments = useCallback(
    (targetIssue: LinearIssue, targetProviderSettings: RuntimeLinearSettings): Promise<void> => {
      const requestId = ++commentsRequestIdRef.current
      setCommentsLoading(true)
      setCommentsError(null)
      return linearIssueComments(targetProviderSettings, targetIssue.id, targetIssue.workspaceId)
        .then((fetched) => {
          if (mountedRef.current && requestId === commentsRequestIdRef.current) {
            setComments(mergeLinearIssueComments(fetched, optimisticCommentsRef.current))
          }
        })
        .catch((error) => {
          if (mountedRef.current && requestId === commentsRequestIdRef.current) {
            setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
          }
        })
        .finally(() => {
          if (mountedRef.current && requestId === commentsRequestIdRef.current) {
            setCommentsLoading(false)
          }
        })
    },
    [mountedRef]
  )

  const retryComments = useCallback(
    () => loadComments(issue, providerSettings),
    [issue, loadComments, providerSettings]
  )

  useEffect(() => {
    const requestId = ++hydrationRequestIdRef.current
    setIssueLoading(true)
    const initialRequest = { issue, providerSettings }
    const release = observeLinearIssueRead(
      useAppStore
        .getState()
        .fetchLinearIssue(initialRequest.issue.id, initialRequest.issue.workspaceId, {
          scope: getLinearSourceScope(initialRequest.providerSettings),
          force: true,
          seed: initialRequest.issue
        }),
      () => mountedRef.current && requestId === hydrationRequestIdRef.current,
      (lease, view) => {
        if (view.kind === 'data' && view.data) {
          setFullIssue((previous) =>
            lease.commit(view, previous, (_, data) => (data ? acceptRead(data) : previous))
          )
          setEditState((previous) =>
            lease.commit(view, previous, (_, data) =>
              data ? acceptRead(initLinearIssueEditState(data)) : previous
            )
          )
        }
        setIssueLoading((previous) => lease.commit(view, previous, () => view.kind === 'loading'))
      }
    )
    void loadComments(initialRequest.issue, initialRequest.providerSettings)
    return () => {
      release()
      hydrationRequestIdRef.current += 1
      commentsRequestIdRef.current += 1
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: requestKey captures source/runtime/issue identity; field updates must not restart hydration.
  }, [acceptRead, loadComments, mountedRef, requestKey])

  return {
    displayed: fullIssue,
    issueLoading,
    comments,
    commentsLoading,
    commentsError,
    editState,
    handleCommentAdded,
    retryComments
  }
}
