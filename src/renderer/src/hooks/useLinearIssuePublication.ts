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
  const key = scope.contextKey
  const identity = useRef({ key, id: issue?.id })
  identity.current = { key, id: issue?.id }
  const consumer = useRef<ReturnType<typeof registerLinearIssueConsumer> | null>(null)
  useEffect(() => {
    if (!issue) {
      return
    }
    const registration = registerLinearIssueConsumer(scope, issue.id, (apply) =>
      callback.current((previous) =>
        scope.isCurrentRuntime() && identity.current.key === key && identity.current.id === issue.id
          ? apply(previous)
          : previous
      )
    )
    consumer.current = registration
    return () => {
      registration.release()
      if (consumer.current === registration) {
        consumer.current = null
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: the complete source/runtime key and provider ID own this subscription, not row field changes.
  }, [issue?.id, key])
  return useCallback(<T extends Partial<LinearIssue>>(next: T): T => {
    consumer.current?.retire()
    return next
  }, [])
}
