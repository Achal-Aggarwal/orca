import type { AppState } from './types'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  mergeHostWorkspaceStatuses
} from '../../../shared/workspace-statuses'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../../shared/worktree/types'
import { getIndexedAllWorktrees } from './worktree-repo-index'
import { selectFolderWorkspaces, selectWorktreesByRepo } from './workspace-record-selectors'

export type HostStatusColumnInputs = Pick<AppState, 'workspaceStatuses'> &
  Partial<Pick<AppState, 'hostWorkspaceStatuses' | 'removedRuntimeEnvironmentIds'>>

type BoardCardInputs = HostStatusColumnInputs &
  Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>

function liveHostStatuses(
  state: HostStatusColumnInputs,
  hostId: string | null | undefined
): readonly WorkspaceStatusDefinition[] | undefined {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime' || state.removedRuntimeEnvironmentIds?.has(host.environmentId)) {
    return undefined
  }
  return state.hostWorkspaceStatuses?.[host.environmentId]
}

/**
 * A host's columns the local list lacks, minus its copy of the default id: local cards fall back
 * to that id, so a host's copy must not move them.
 */
function hostOnlyColumns(
  state: HostStatusColumnInputs,
  hostStatuses: readonly WorkspaceStatusDefinition[]
): readonly WorkspaceStatusDefinition[] {
  return hostStatuses.filter(
    (status) =>
      status.id !== DEFAULT_WORKSPACE_STATUS_ID &&
      !state.workspaceStatuses.some((local) => local.id === status.id)
  )
}

/** The columns offered for a card on this host: the local ones plus, for a paired runtime host, its own. */
export function selectWorkspaceStatusesForHost(
  state: HostStatusColumnInputs,
  hostId: string | null | undefined
): readonly WorkspaceStatusDefinition[] {
  const hostStatuses = liveHostStatuses(state, hostId)
  const extra = hostStatuses ? hostOnlyColumns(state, hostStatuses) : []
  return extra.length > 0 ? [...state.workspaceStatuses, ...extra] : state.workspaceStatuses
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

/** The board's lanes: local columns, then the paired hosts' columns their own cards sit in. */
export function selectWorkspaceBoardStatuses(
  state: BoardCardInputs
): readonly WorkspaceStatusDefinition[] {
  const local = state.workspaceStatuses
  const candidates = new Map<string, readonly WorkspaceStatusDefinition[]>()
  for (const environmentId of Object.keys(state.hostWorkspaceStatuses ?? {}).sort()) {
    const hostStatuses = liveHostStatuses(state, toRuntimeExecutionHostId(environmentId))
    const extra = hostStatuses ? hostOnlyColumns(state, hostStatuses) : []
    if (extra.length > 0) {
      candidates.set(environmentId, extra)
    }
  }
  // Why: most pairings share the local columns, so skip the card scan.
  if (candidates.size === 0) {
    return local
  }
  const usedByEnvironment = new Map<string, Set<string>>()
  const noteCard = (hostId: string | null | undefined, status: WorkspaceStatus | undefined) => {
    const host = parseExecutionHostId(hostId)
    if (status && host?.kind === 'runtime' && candidates.has(host.environmentId)) {
      const used = usedByEnvironment.get(host.environmentId) ?? new Set<string>()
      usedByEnvironment.set(host.environmentId, used.add(status))
    }
  }
  for (const worktree of getIndexedAllWorktrees(selectWorktreesByRepo(state))) {
    noteCard(worktree.hostId, worktree.workspaceStatus)
  }
  for (const folder of selectFolderWorkspaces(state)) {
    noteCard(folder.executionHostId, folder.workspaceStatus)
  }
  const extra: WorkspaceStatusDefinition[] = []
  const seen = new Set<string>()
  // Sorted above so lanes keep their order whichever host replied first.
  for (const [environmentId, columns] of candidates) {
    const used = usedByEnvironment.get(environmentId)
    for (const status of columns) {
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
  hostId: string | null | undefined,
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
  hostId: string | null | undefined,
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
