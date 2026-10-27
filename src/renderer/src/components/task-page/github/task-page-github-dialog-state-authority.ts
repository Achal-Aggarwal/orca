import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../../shared/github/pull-request-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import {
  deleteLastConfirmedClientValue,
  getLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'
import {
  getTaskPageGitHubMutationQueryKey,
  getConfirmedListSnapshot,
  listPendingTaskPageGitHubOpsForItem,
  notifyTaskPageGitHubMutationRegistry,
  setConfirmedListSnapshot,
  setLastConfirmedClientValue
} from './task-page-github-work-item-mutation-registry'
import { markTaskPageGitHubFamiliesDirty } from './task-page-github-work-item-quiet-state'
import { taskPageGitHubItemKey } from './task-page-github-work-item-mutation-keys'
import { applyTaskPageGitHubListOps } from './task-page-github-work-item-mutation-patches'
import {
  getRegistryMergedTaskPageGitHubWorkItem,
  stripFamilyPendingFromList
} from './task-page-github-work-item-mutation-composition'

function markFamilyDirty(repoId: string, itemId: string, family: 'state' | 'assignees'): void {
  const queryKey = getTaskPageGitHubMutationQueryKey()
  if (queryKey !== null) {
    markTaskPageGitHubFamiliesDirty(queryKey, taskPageGitHubItemKey(repoId, itemId), [family])
  }
}

/** Hold confirmed dialog state in the registry until search catches up; matching quiet adoption releases it so external reverts can win. */
export function assertTaskPageGitHubDialogStateAuthority(args: {
  repoId: string
  itemId: string
  state: GitHubWorkItem['state']
  sourceContext?: TaskSourceContext | null
  ownerRepo?: GitHubOwnerRepo | null
}): { revert: () => boolean } {
  const sourceScope =
    args.sourceContext?.provider === 'github' ? getTaskSourceCacheScope(args.sourceContext) : null
  const previous = getLastConfirmedClientValue(
    sourceScope,
    args.repoId,
    args.itemId,
    'state',
    args.ownerRepo
  )
  setLastConfirmedClientValue(
    sourceScope,
    args.repoId,
    args.itemId,
    'state',
    args.state,
    args.ownerRepo
  )
  markFamilyDirty(args.repoId, args.itemId, 'state')
  notifyTaskPageGitHubMutationRegistry()
  return {
    revert: () => {
      const current = getLastConfirmedClientValue(
        sourceScope,
        args.repoId,
        args.itemId,
        'state',
        args.ownerRepo
      )
      // A matching search adopt or newer mutation owns the state now.
      if (current !== args.state) {
        return false
      }
      if (previous === undefined) {
        deleteLastConfirmedClientValue(
          sourceScope,
          args.repoId,
          args.itemId,
          'state',
          args.ownerRepo
        )
      } else {
        setLastConfirmedClientValue(
          sourceScope,
          args.repoId,
          args.itemId,
          'state',
          previous,
          args.ownerRepo
        )
      }
      markFamilyDirty(args.repoId, args.itemId, 'state')
      notifyTaskPageGitHubMutationRegistry()
      return true
    }
  }
}

/** Publish only the successful login delta; pending list edits remain separate from confirmed data. */
export function publishTaskPageGitHubDialogAssigneeChange(args: {
  item: GitHubWorkItem
  user: GitHubAssignableUser
  assigned: boolean
  sourceContext?: TaskSourceContext | null
  ownerRepo?: GitHubOwnerRepo | null
}): GitHubWorkItem {
  const { item, ownerRepo } = args
  const scope =
    args.sourceContext?.provider === 'github' ? getTaskSourceCacheScope(args.sourceContext) : null
  const snapshot =
    getConfirmedListSnapshot(scope, item.repoId, item.id, 'assignees', ownerRepo) ??
    stripFamilyPendingFromList(
      item,
      'assignees',
      listPendingTaskPageGitHubOpsForItem(item.repoId, item.id, scope)
    )
  const users = applyTaskPageGitHubListOps(snapshot, [
    {
      family: 'assignees',
      kind: args.assigned ? 'add' : 'remove',
      logins: [args.user.login.toLowerCase()],
      users: [args.user]
    }
  ])
  setConfirmedListSnapshot(scope, item.repoId, item.id, 'assignees', users, ownerRepo)
  markFamilyDirty(item.repoId, item.id, 'assignees')
  notifyTaskPageGitHubMutationRegistry()
  return getRegistryMergedTaskPageGitHubWorkItem(item, scope)
}
