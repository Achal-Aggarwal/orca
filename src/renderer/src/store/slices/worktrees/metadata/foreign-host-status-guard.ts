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
    const allowed = withoutForeignHostStatus(get(), hostId, updates)
    // Why: a write that was only the dropped status has nothing left to persist.
    if (allowed !== updates && Object.keys(allowed).length === 0) {
      return Promise.resolve({ ok: true as const })
    }
    return update(worktreeId, allowed, options)
  }
}

export function guardUpdateWorktreesMetaHostStatus(
  update: WorktreeSlice['updateWorktreesMeta'],
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreesMeta'] {
  return (entries) => {
    const state = get()
    return update(
      entries.flatMap((entry) => {
        const allowed = withoutForeignHostStatus(
          state,
          entry.executionHostId ?? findKnownWorktreeById(state, entry.worktreeId)?.hostId,
          entry.updates
        )
        return allowed !== entry.updates && Object.keys(allowed).length === 0
          ? []
          : [{ ...entry, updates: allowed }]
      })
    )
  }
}
