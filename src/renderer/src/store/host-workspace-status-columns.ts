import type { AppState } from './types'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  mergeHostWorkspaceStatuses
} from '../../../shared/workspace-statuses'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'

export type HostStatusColumnInputs = Pick<AppState, 'workspaceStatuses'> &
  Partial<Pick<AppState, 'hostWorkspaceStatuses' | 'removedRuntimeEnvironmentIds'>>

type BoardCardInputs = HostStatusColumnInputs &
  Partial<Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>>

function liveHostStatuses(
  state: HostStatusColumnInputs,
  hostId: ExecutionHostId | string | null | undefined
): readonly WorkspaceStatusDefinition[] | undefined {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime' || state.removedRuntimeEnvironmentIds?.has(host.environmentId)) {
    return undefined
  }
  return state.hostWorkspaceStatuses?.[host.environmentId]
}

/** The columns a card on this host may sit in: the local ones plus, for a paired runtime host, its own. */
export function selectWorkspaceStatusesForHost(
  state: HostStatusColumnInputs,
  hostId: ExecutionHostId | string | null | undefined
): readonly WorkspaceStatusDefinition[] {
  const hostStatuses = liveHostStatuses(state, hostId)
  return hostStatuses
    ? mergeHostWorkspaceStatuses(state.workspaceStatuses, [hostStatuses])
    : state.workspaceStatuses
}

/** Every column id in use locally or on any paired host, so a new local column gets a fresh id. */
export function selectAllKnownWorkspaceStatuses(
  state: HostStatusColumnInputs
): readonly WorkspaceStatusDefinition[] {
  return mergeHostWorkspaceStatuses(
    state.workspaceStatuses,
    Object.values(state.hostWorkspaceStatuses ?? {})
  )
}

function boardCards(
  state: BoardCardInputs
): Iterable<{ hostId?: string | null; workspaceStatus?: WorkspaceStatus }> {
  const worktrees: readonly Worktree[] = Object.values(state.worktreesByRepo ?? {}).flat()
  const folders: readonly FolderWorkspace[] = state.folderWorkspaces ?? []
  return [
    ...worktrees,
    ...folders.map((folder) => ({
      hostId: folder.executionHostId,
      workspaceStatus: folder.workspaceStatus
    }))
  ]
}

/**
 * The board's lanes: local columns, then the paired hosts' columns their own cards sit in.
 * Why skip the default id: local cards fall back to it, so a host's copy must not move them.
 */
export function selectWorkspaceBoardStatuses(
  state: BoardCardInputs
): readonly WorkspaceStatusDefinition[] {
  const local = state.workspaceStatuses
  if (Object.keys(state.hostWorkspaceStatuses ?? {}).length === 0) {
    return local
  }
  const localIds = new Set(local.map((status) => status.id))
  const usedByEnvironment = new Map<string, Set<string>>()
  for (const card of boardCards(state)) {
    const status = card.workspaceStatus
    if (!status || localIds.has(status) || status === DEFAULT_WORKSPACE_STATUS_ID) {
      continue
    }
    const host = parseExecutionHostId(card.hostId)
    if (host?.kind === 'runtime') {
      const used = usedByEnvironment.get(host.environmentId) ?? new Set<string>()
      usedByEnvironment.set(host.environmentId, used.add(status))
    }
  }
  const extra: WorkspaceStatusDefinition[] = []
  const seen = new Set(localIds)
  // Sorted so lanes keep their order whichever host replied first.
  for (const environmentId of [...usedByEnvironment.keys()].sort()) {
    const used = usedByEnvironment.get(environmentId)
    for (const status of liveHostStatuses(state, toRuntimeExecutionHostId(environmentId)) ?? []) {
      if (used?.has(status.id) && !seen.has(status.id)) {
        seen.add(status.id)
        extra.push(status)
      }
    }
  }
  return extra.length > 0 ? [...local, ...extra] : local
}

/** False for another paired host's column: a card may only take its own host's columns or local ones. */
export function isWorkspaceStatusAllowedOnHost(
  state: HostStatusColumnInputs,
  hostId: ExecutionHostId | string | null | undefined,
  status: WorkspaceStatus
): boolean {
  const pairedColumns = Object.values(state.hostWorkspaceStatuses ?? {})
  if (
    pairedColumns.length === 0 ||
    state.workspaceStatuses.some((column) => column.id === status)
  ) {
    return true
  }
  if (liveHostStatuses(state, hostId)?.some((column) => column.id === status)) {
    return true
  }
  // Why: ids no paired host defines keep their old behavior.
  return !pairedColumns.some((columns) => columns.some((column) => column.id === status))
}

/** Drops a status write that would put a card in another paired host's column; other fields still apply. */
export function withoutForeignHostStatus<T extends { workspaceStatus?: WorkspaceStatus }>(
  state: HostStatusColumnInputs,
  hostId: ExecutionHostId | string | null | undefined,
  updates: T
): Omit<T, 'workspaceStatus'> & Pick<Partial<T>, 'workspaceStatus'> {
  if (
    !updates.workspaceStatus ||
    isWorkspaceStatusAllowedOnHost(state, hostId, updates.workspaceStatus)
  ) {
    return updates
  }
  const { workspaceStatus: _dropped, ...rest } = updates
  return rest
}
