import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import { findKnownWorktreeById } from '../listing/detected-worktree-meta'
import { withoutForeignHostStatus } from '../../../host-workspace-status-columns'

/** Every status write path keeps a card out of another paired host's columns. */
export function guardUpdateWorktreeMetaHostStatus(
  update: WorktreeSlice['updateWorktreeMeta'],
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeMeta'] {
  return (worktreeId, updates, options) => {
    const hostId =
      options?.executionHostId ??
      findKnownWorktreeById(get(), worktreeId, options?.executionHostId)?.hostId
    return update(worktreeId, withoutForeignHostStatus(get(), hostId, updates), options)
  }
}

export function guardUpdateWorktreesMetaHostStatus(
  update: WorktreeSlice['updateWorktreesMeta'],
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreesMeta'] {
  return (entries) => {
    const state = get()
    return update(
      entries.map((entry) => ({
        ...entry,
        updates: withoutForeignHostStatus(
          state,
          entry.executionHostId ?? findKnownWorktreeById(state, entry.worktreeId)?.hostId,
          entry.updates
        )
      }))
    )
  }
}
