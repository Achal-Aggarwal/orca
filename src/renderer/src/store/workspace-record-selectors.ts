import type { Worktree } from '../../../shared/worktree/types'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  findIndexedWorktreeOwnerForHost,
  resolveQualifiedIndexedFolderWorkspace
} from '@/lib/worktree-runtime-owner-index'
import type { AppState } from './types'
import { getFolderWorkspaceWorktree } from './slices/worktrees/listing/detected-worktree-meta'

// The one read path for workspace records. Backed by today's store fields; readers outside the
// writers go through here (config/scripts/check-workspace-record-read-ratchet.mjs).

export type WorkspaceRecordState = Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'> &
  Partial<Pick<AppState, 'repos' | 'projectGroups'>>

// ─── Compatibility views ─────────────────────────────────────────────

/** Git worktrees per repo id, in listing order. */
export function selectWorktreesByRepo(
  state: Pick<AppState, 'worktreesByRepo'>
): AppState['worktreesByRepo'] {
  return state.worktreesByRepo
}

export function selectFolderWorkspaces(
  state: Pick<AppState, 'folderWorkspaces'>
): AppState['folderWorkspaces'] {
  return state.folderWorkspaces
}

/** Checkouts git reports that Orca does not track, per repo id. */
export function selectDetectedWorktreesByRepo(
  state: Pick<AppState, 'detectedWorktreesByRepo'>
): AppState['detectedWorktreesByRepo'] {
  return state.detectedWorktreesByRepo
}

// ─── Keyed records ───────────────────────────────────────────────────

/**
 * The row that owns `target` on its host, including a paired runtime's logical host alias.
 * An ambiguous owner on that host answers undefined.
 */
export function selectWorkspaceByHostTarget(
  state: WorkspaceRecordState,
  target: HostWorktreeTarget
): Worktree | undefined {
  const scope = parseWorkspaceKey(target.id)
  if (scope?.type === 'folder') {
    const result = resolveQualifiedIndexedFolderWorkspace(
      state,
      scope.folderWorkspaceId,
      target.hostId
    )
    return result.kind === 'selected'
      ? getFolderWorkspaceWorktree(result.value.workspace, result.value)
      : undefined
  }
  return (
    findIndexedWorktreeOwnerForHost(state.worktreesByRepo, target.id, target.hostId) ?? undefined
  )
}
