import { useAppStore } from '@/store'
import { useCallback, useEffect, useRef } from 'react'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import {
  registerLinearIssueConsumer,
  type LinearIssuePublication
} from '@/store/slices/linear/linear-issue-publication'

export function useLinearIssuePublication(
  issue: LinearIssue | null,
  source: RuntimeLinearSettings,
  publish: (apply: LinearIssuePublication) => void
) {
  const callback = useRef(publish)
  callback.current = publish
  const scope = getLinearSourceScope(source)
  const key = useAppStore(() => getLinearSourceScope(source).contextKey)
  const identity = useRef({ key, id: issue?.id, workspaceId: issue?.workspaceId })
  identity.current = { key, id: issue?.id, workspaceId: issue?.workspaceId }
  const consumer = useRef<ReturnType<typeof registerLinearIssueConsumer> | null>(null)
  // oxlint-disable react-hooks/exhaustive-deps -- Why: key captures the complete source/runtime; saved-field edits must not restart hydration.
  const isCurrent = useCallback(
    () =>
      scope.isCurrentRuntime() &&
      identity.current.key === key &&
      identity.current.id === issue?.id &&
      identity.current.workspaceId === issue?.workspaceId,
    [key, issue?.id, issue?.workspaceId]
  )
  // oxlint-enable react-hooks/exhaustive-deps
  useEffect(() => {
    if (!issue) {
      return
    }
    const registration = registerLinearIssueConsumer(scope, issue.id, (apply) =>
      callback.current((previous) => (isCurrent() ? apply(previous) : previous))
    )
    consumer.current = registration
    return () => {
      registration.release()
      if (consumer.current === registration) {
        consumer.current = null
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: the complete source/runtime key and provider ID own this subscription, not row field changes.
  }, [issue?.id, issue?.workspaceId, key])
  const acceptRead = useCallback(
    <T extends Partial<LinearIssue>>(next: T): T => {
      if (isCurrent()) {
        consumer.current?.retire()
      }
      return next
    },
    [isCurrent]
  )
  return { acceptRead, isCurrent }
}
