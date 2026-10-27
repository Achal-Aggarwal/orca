import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { useImmediateMutation } from '@/hooks/useIssueMetadata'
import {
  buildTaskPageGitHubCloseUpdate,
  getTaskPageGitHubDuplicateTargetErrorMessage,
  validateTaskPageGitHubDuplicateTarget,
  type TaskPageGitHubCloseAction
} from '@/components/task-page/github/task-page-github-status-actions'
import {
  assertTaskPageGitHubDialogStateAuthority,
  publishTaskPageGitHubDialogAssigneeChange
} from '@/components/task-page/github/task-page-github-dialog-state-authority'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubPatchWorkItemOptions } from '@/store/github/cache-model'
import { translate } from '@/i18n/i18n'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'

export type GHEditProjectRowPatch = {
  state?: GitHubWorkItem['state']
  labels?: string[]
  assignees?: string[]
}

export type GHEditMutationRun = ReturnType<typeof useImmediateMutation>['run']

type GHEditMutationBase = {
  itemNumber: GitHubWorkItem['number']
  itemRepoId: GitHubWorkItem['repoId']
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  issueRepo?: GitHubOwnerRepo | null
  run: GHEditMutationRun
  patchProjectRowIfNeeded: (patch: GHEditProjectRowPatch) => void
  onMutated: () => void
}

export function runGHEditStateChange({
  newState,
  closeAction,
  localState,
  itemId,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
  issueRepo,
  run,
  onStateChange,
  patchWorkItem,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  itemId: GitHubWorkItem['id']
  newState: 'open' | 'closed'
  closeAction?: TaskPageGitHubCloseAction
  localState: GitHubWorkItem['state']
  onStateChange: (state: GitHubWorkItem['state']) => void
  patchWorkItem: (
    id: string,
    patch: { state: GitHubWorkItem['state'] },
    repoId: string | undefined,
    options: GitHubPatchWorkItemOptions
  ) => void
}): void {
  // Why: a close reason still has to reach GitHub even when the item already reads as closed locally.
  if (newState === localState && !closeAction) {
    return
  }
  const prevState = localState
  // Keep registry authority so search-lagged Tasks refetches cannot revert this mutation.
  let authority: { revert: () => boolean } | null = null
  void run('state', {
    mutate: () =>
      runIssueUpdate({
        repoId: itemRepoId,
        repoPath,
        sourceContext,
        projectOrigin,
        issueRepo,
        number: itemNumber,
        updates:
          newState === 'closed' && closeAction
            ? buildTaskPageGitHubCloseUpdate(closeAction)
            : { state: newState }
      }),
    onOptimistic: () => {
      authority = assertTaskPageGitHubDialogStateAuthority({
        repoId: itemRepoId,
        itemId,
        state: newState,
        sourceContext,
        ownerRepo: projectOrigin ?? issueRepo
      })
      onStateChange(newState)
      patchWorkItem(itemId, { state: newState }, itemRepoId, {
        sourceContext,
        ownerRepo: projectOrigin ?? issueRepo
      })
      patchProjectRowIfNeeded({ state: newState })
    },
    onRevert: () => {
      if (authority?.revert()) {
        onStateChange(prevState)
        patchWorkItem(itemId, { state: prevState }, itemRepoId, {
          sourceContext,
          ownerRepo: projectOrigin ?? issueRepo
        })
        patchProjectRowIfNeeded({ state: prevState })
      }
    },
    onSuccess: () => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      patchWorkItem(itemId, { state: newState }, itemRepoId, {
        sourceContext,
        ownerRepo: projectOrigin ?? issueRepo
      })
      patchProjectRowIfNeeded({ state: newState })
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export function closeGHEditAsDuplicate({
  targetIssueNumber,
  itemNumber,
  setDuplicateError,
  handleStateChange,
  setStatusPopoverOpen,
  setDuplicatePickerOpen
}: {
  targetIssueNumber: number | string
  itemNumber: number
  setDuplicateError: (value: string | null) => void
  handleStateChange: (newState: 'open' | 'closed', closeAction?: TaskPageGitHubCloseAction) => void
  setStatusPopoverOpen: (value: boolean) => void
  setDuplicatePickerOpen: (value: boolean) => void
}): void {
  const validation = validateTaskPageGitHubDuplicateTarget(String(targetIssueNumber), itemNumber)
  if (!validation.ok) {
    setDuplicateError(getTaskPageGitHubDuplicateTargetErrorMessage(validation, translate))
    return
  }
  setDuplicateError(null)
  handleStateChange('closed', { stateReason: 'duplicate', duplicateOf: validation.duplicateOf })
  setStatusPopoverOpen(false)
  setDuplicatePickerOpen(false)
}

export function runGHEditLabelToggle({
  label,
  localLabels,
  itemId,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
  issueRepo,
  run,
  onLabelsChange,
  patchWorkItem,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  itemId: GitHubWorkItem['id']
  label: string
  localLabels: string[]
  onLabelsChange: (labels: string[]) => void
  patchWorkItem: (
    id: string,
    patch: { labels: string[] },
    repoId: string | undefined,
    options: GitHubPatchWorkItemOptions
  ) => void
}): void {
  const isAdding = !localLabels.includes(label)
  const prevLabels = localLabels
  const newLabels = isAdding ? [...prevLabels, label] : prevLabels.filter((l) => l !== label)

  void run('labels', {
    mutate: () =>
      runIssueUpdate({
        repoId: itemRepoId,
        repoPath,
        sourceContext,
        projectOrigin,
        issueRepo,
        number: itemNumber,
        updates: isAdding ? { addLabels: [label] } : { removeLabels: [label] }
      }),
    onOptimistic: () => {
      onLabelsChange(newLabels)
      patchWorkItem(itemId, { labels: newLabels }, itemRepoId, {
        sourceContext,
        ownerRepo: projectOrigin ?? issueRepo
      })
      patchProjectRowIfNeeded({ labels: newLabels })
    },
    onRevert: () => {
      onLabelsChange(prevLabels)
      patchWorkItem(itemId, { labels: prevLabels }, itemRepoId, {
        sourceContext,
        ownerRepo: projectOrigin ?? issueRepo
      })
      patchProjectRowIfNeeded({ labels: prevLabels })
    },
    onSuccess: () => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export function runGHEditAssigneeToggle({
  item,
  knownAssignees,
  login,
  localAssignees,
  assigneesItemKey,
  editedAssigneesItemKeyRef,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
  issueRepo,
  run,
  setLocalAssignees,
  patchWorkItem,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  item: GitHubWorkItem
  knownAssignees: GitHubAssignableUser[]
  login: string
  localAssignees: string[]
  assigneesItemKey: string
  editedAssigneesItemKeyRef: { current: string | null }
  setLocalAssignees: (value: string[]) => void
  patchWorkItem: (
    id: string,
    patch: Partial<GitHubWorkItem>,
    repoId: string | undefined,
    options: GitHubPatchWorkItemOptions
  ) => void
}): void {
  const isAssigned = localAssignees.includes(login)
  const prevAssignees = localAssignees
  const newAssignees = isAssigned
    ? prevAssignees.filter((l) => l !== login)
    : [...prevAssignees, login]
  const resolveUser = (login: string): GitHubAssignableUser =>
    knownAssignees.find((user) => user.login.toLowerCase() === login.toLowerCase()) ?? {
      login,
      name: null,
      avatarUrl: ''
    }

  // Why: scope the optimistic guard to this repo item so switching items doesn't suppress the next item's assignee sync.
  editedAssigneesItemKeyRef.current = assigneesItemKey
  void run('assignees', {
    mutate: () =>
      runIssueUpdate({
        repoId: itemRepoId,
        repoPath,
        sourceContext,
        projectOrigin,
        issueRepo,
        number: itemNumber,
        updates: isAssigned ? { removeAssignees: [login] } : { addAssignees: [login] }
      }),
    onOptimistic: () => {
      setLocalAssignees(newAssignees)
      patchProjectRowIfNeeded({ assignees: newAssignees })
    },
    onSuccess: () => {
      const confirmed = publishTaskPageGitHubDialogAssigneeChange({
        item,
        user: resolveUser(login),
        assigned: !isAssigned,
        sourceContext,
        ownerRepo: projectOrigin ?? issueRepo
      })
      patchWorkItem(item.id, { assignees: confirmed.assignees }, itemRepoId, {
        sourceContext,
        ownerRepo: projectOrigin ?? issueRepo
      })
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onRevert: () => {
      // Why: leaving the guard set after a failed toggle suppresses assignee prop syncs indefinitely.
      editedAssigneesItemKeyRef.current = null
      setLocalAssignees(prevAssignees)
      patchProjectRowIfNeeded({ assignees: prevAssignees })
    },
    onError: (err) => toast.error(err)
  })
}
