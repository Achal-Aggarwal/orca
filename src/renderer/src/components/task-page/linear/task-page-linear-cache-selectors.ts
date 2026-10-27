import { useAppStore } from '@/store'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import { LINEAR_ISSUE_LIST_MAX } from '../../../../../shared/linear/issue-read-limits'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { sortedStrings } from '../task-page-work-item-signatures'

function linearIssueKey(issue: LinearIssue): string {
  return issue.id
}

function linearIssueStatusSignature(issue: LinearIssue): string {
  return JSON.stringify([
    issue.identifier,
    issue.title,
    issue.url,
    issue.state.name,
    issue.state.type,
    issue.state.color,
    issue.team.id,
    issue.team.name,
    issue.team.key,
    sortedStrings(issue.labels),
    issue.assignee?.id ?? null,
    issue.assignee?.displayName ?? null,
    issue.priority,
    issue.updatedAt
  ])
}

export function shouldReplaceTaskPageLinearIssuesAfterRefresh(
  currentIssues: readonly LinearIssue[],
  refreshedIssues: readonly LinearIssue[]
): boolean {
  if (currentIssues.length !== refreshedIssues.length) {
    return true
  }
  const currentKeys = new Set(currentIssues.map(linearIssueKey))
  return refreshedIssues.some((issue) => !currentKeys.has(linearIssueKey(issue)))
}

export function reconcileTaskPageLinearIssuesAfterLandingRefresh(
  currentIssues: readonly LinearIssue[],
  refreshedIssues: readonly LinearIssue[]
): LinearIssue[] {
  if (shouldReplaceTaskPageLinearIssuesAfterRefresh(currentIssues, refreshedIssues)) {
    return [...refreshedIssues]
  }
  const refreshedByKey = new Map(refreshedIssues.map((issue) => [linearIssueKey(issue), issue]))
  let changed = false
  const next = currentIssues.map((issue) => {
    const refreshed = refreshedByKey.get(linearIssueKey(issue))
    if (!refreshed || linearIssueStatusSignature(issue) === linearIssueStatusSignature(refreshed)) {
      return issue
    }
    changed = true
    return refreshed
  })
  return changed ? next : (currentIssues as LinearIssue[])
}

export function subscribeToTaskPageLinearIssues(
  read: () => LinearIssue[] | null,
  publish: (issues: LinearIssue[]) => void
): () => void {
  let previous = read()
  return useAppStore.subscribe(() => {
    const issues = read()
    if (issues && issues !== previous) {
      previous = issues
      publish(issues)
    }
  })
}

export function taskPageLinearIssuesHaveMore(
  result: LinearIssue[] | LinearCollectionResult<LinearIssue> | null,
  limit: number
): boolean {
  return !Array.isArray(result) && Boolean(result?.hasMore) && limit < LINEAR_ISSUE_LIST_MAX
}
