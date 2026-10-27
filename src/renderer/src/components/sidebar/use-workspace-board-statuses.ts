import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  selectWorkspaceBoardStatuses,
  selectWorkspaceStatusesForHost
} from '@/store/host-workspace-status-columns'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'

/** The columns cards group by: local ones plus the paired hosts' columns their own cards use. Edits use the local list. */
export function useWorkspaceBoardStatuses(): readonly WorkspaceStatusDefinition[] {
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const hostWorkspaceStatuses = useAppStore((s) => s.hostWorkspaceStatuses)
  const removedRuntimeEnvironmentIds = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  const folderWorkspaces = useAppStore(selectFolderWorkspaces)
  return useMemo(
    () =>
      selectWorkspaceBoardStatuses({
        workspaceStatuses,
        hostWorkspaceStatuses,
        removedRuntimeEnvironmentIds,
        worktreesByRepo,
        folderWorkspaces
      }),
    [
      workspaceStatuses,
      hostWorkspaceStatuses,
      removedRuntimeEnvironmentIds,
      worktreesByRepo,
      folderWorkspaces
    ]
  )
}

/** The columns offered for a card or target on this host; null means a mix of hosts, so local only. */
export function useWorkspaceStatusesForHost(
  hostId: string | null | undefined
): readonly WorkspaceStatusDefinition[] {
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const hostWorkspaceStatuses = useAppStore((s) => s.hostWorkspaceStatuses)
  const removedRuntimeEnvironmentIds = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  return useMemo(
    () =>
      selectWorkspaceStatusesForHost(
        { workspaceStatuses, hostWorkspaceStatuses, removedRuntimeEnvironmentIds },
        hostId
      ),
    [workspaceStatuses, hostWorkspaceStatuses, removedRuntimeEnvironmentIds, hostId]
  )
}
