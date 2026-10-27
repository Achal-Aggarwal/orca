import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import type { HostAuthority } from '../../../shared/host-authority'
import { findFolderWorkspaceOwner } from './folder-workspace-runtime-owner'
import { resolveOwner } from './resolve-owner'
import { captureDirectSshMutationExpectation } from './ssh-mutation-expectation'
import { resolveQualifiedIndexedFolderWorkspace } from './worktree-runtime-owner-index'
import {
  assertWorktreeOperationGenerationSnapshotCurrent,
  captureWorktreeOperationGenerationSnapshot,
  type WorktreeOperationGenerationSnapshot
} from './worktree-operation-generation'
import {
  getFloatingWorkspaceOperationRoute,
  resolveWorktreeOperationRoute,
  type WorktreeOperationRoute
} from './worktree-operation-route'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-catalog-route'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

export type EditorFileOperationProvenance = {
  generation: WorktreeOperationGenerationSnapshot
  ownershipProjection: 'explicit' | 'legacy'
  expectedSshConnectionGeneration?: number
}

type EditorOwnerState = Pick<
  AppState,
  | 'settings'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'runtimeEnvironments'
  | 'runtimeEnvironmentCatalogHydrated'
  | 'removedRuntimeEnvironmentIds'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
>

export const OWNER_CHANGED_MESSAGE =
  "Couldn't verify which host owns this file. Reopen the file after the connection settles."

export function captureEditorFileOperationProvenance(
  state: EditorOwnerState,
  worktreeId: string,
  ownerHint: string | null | undefined,
  ownerHintProvided: boolean
): EditorFileOperationProvenance {
  const explicitResolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  const worktreeIsPublished = isWorktreePublished(state, worktreeId)
  const ownershipProjection =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID || explicitResolution.kind === 'resolved'
      ? 'explicit'
      : 'legacy'
  const hintedRuntimeEnvironmentId = ownerHint?.trim() || null
  const route =
    getFloatingWorkspaceOperationRoute(worktreeId) ??
    (explicitResolution.kind === 'resolved'
      ? explicitResolution.route
      : explicitResolution.kind === 'ambiguous'
        ? null
        : ownerHintProvided && worktreeIsPublished
          ? {
              executionHostId: hintedRuntimeEnvironmentId
                ? (`runtime:${encodeURIComponent(hintedRuntimeEnvironmentId)}` as const)
                : ('local' as const),
              runtimeEnvironmentId: hintedRuntimeEnvironmentId
            }
          : resolveEditorOwnerRoute(state, worktreeId))
  if (!route || (ownerHintProvided && (ownerHint?.trim() || null) !== route.runtimeEnvironmentId)) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  const authority = resolveEditorOperationAuthority(state, worktreeId, route)
  const expectedSshConnectionGeneration = getExpectedSshConnectionGeneration(
    state,
    route,
    authority
  )
  return {
    generation: captureWorktreeOperationGenerationSnapshot(route, authority),
    ownershipProjection,
    ...(expectedSshConnectionGeneration === undefined ? {} : { expectedSshConnectionGeneration })
  }
}

function resolveEditorOperationAuthority(
  state: EditorOwnerState,
  worktreeId: string,
  route: WorktreeOperationRoute
): HostAuthority | undefined {
  if (!route.executionHostId) {
    return undefined
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const folder = resolveQualifiedIndexedFolderWorkspace(
      state,
      scope.folderWorkspaceId,
      route.executionHostId
    )
    if (folder.kind !== 'selected' || !folder.value.workspace.folderPath) {
      return undefined
    }
  } else if (worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
    const explicit = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
    if (explicit.kind !== 'resolved' || JSON.stringify(explicit.route) !== JSON.stringify(route)) {
      return undefined
    }
  }
  const match = resolveOwner(
    { ...state, activeWorktreeId: null, activeWorkspaceExecutionHostId: null },
    { workspaceId: worktreeId, ...(route.executionHostId ? { hostId: route.executionHostId } : {}) }
  )
  if (match.kind !== 'resolved') {
    return undefined
  }
  const environmentId =
    match.owner.endpoint.kind === 'environment' ? match.owner.endpoint.environmentId : null
  return environmentId === route.runtimeEnvironmentId ? match.owner : undefined
}

function resolveEditorOwnerRoute(
  state: EditorOwnerState,
  worktreeId: string,
  capturedHostId?: ExecutionHostId | null
): WorktreeOperationRoute | null {
  // Neither workspace focus nor the Active Server focus can replace a file's catalog owner.
  const ownerState = { ...state, activeWorktreeId: null, activeWorkspaceExecutionHostId: null }
  const route = resolveWorktreeOperationRoute(ownerState, worktreeId)
  const scope = parseWorkspaceKey(worktreeId)
  const hostId =
    capturedHostId ??
    (state.activeWorktreeId === worktreeId ? state.activeWorkspaceExecutionHostId : null)
  if (route || scope?.type !== 'folder' || !hostId) {
    return route
  }
  // Same-id folders may use a host qualifier only when the catalog confirms that owner.
  const folder = findFolderWorkspaceOwner(ownerState, scope.folderWorkspaceId, hostId)
  const qualifiedRoute = folder
    ? resolveWorktreeOperationRoute({ ...ownerState, folderWorkspaces: [folder] }, worktreeId)
    : null
  return qualifiedRoute?.executionHostId === hostId ? qualifiedRoute : null
}

export function assertEditorFileOperationCurrent(
  state: EditorOwnerState,
  worktreeId: string,
  provenance: EditorFileOperationProvenance
): WorktreeOperationRoute {
  const route = assertWorktreeOperationGenerationSnapshotCurrent(
    () => state,
    worktreeId,
    provenance.generation,
    () => new Error(OWNER_CHANGED_MESSAGE),
    () => resolveCurrentEditorRoute(state, worktreeId, provenance),
    () => resolveEditorOperationAuthority(state, worktreeId, provenance.generation.route)
  )
  const currentGeneration = getExpectedSshConnectionGeneration(
    state,
    route,
    provenance.generation.authority
  )
  if (currentGeneration !== provenance.expectedSshConnectionGeneration) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  return route
}

function resolveCurrentEditorRoute(
  state: EditorOwnerState,
  worktreeId: string,
  provenance: EditorFileOperationProvenance
): WorktreeOperationRoute | null {
  const floatingRoute = getFloatingWorkspaceOperationRoute(worktreeId)
  if (floatingRoute) {
    return floatingRoute
  }
  const explicitResolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  if (explicitResolution.kind === 'resolved') {
    return explicitResolution.route
  }
  if (explicitResolution.kind === 'ambiguous' || provenance.ownershipProjection === 'explicit') {
    return null
  }
  // Why: ordinary folder workspaces have no published worktree row, so re-resolve their live
  // folder owner after preserving the explicit-owner fail-closed contract above (#10251).
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return resolveEditorOwnerRoute(state, worktreeId, provenance.generation.route.executionHostId)
  }
  return isWorktreePublished(state, worktreeId) ? provenance.generation.route : null
}

function isWorktreePublished(state: EditorOwnerState, worktreeId: string): boolean {
  return (
    Object.values(selectWorktreesByRepo(state) ?? {}).some((worktrees) =>
      worktrees.some((worktree) => worktree.id === worktreeId)
    ) ||
    Object.values(selectDetectedWorktreesByRepo(state) ?? {}).some((result) =>
      result.worktrees.some((worktree) => worktree.id === worktreeId)
    )
  )
}

export function getExpectedSshConnectionGeneration(
  state: Pick<AppState, 'sshConnectionStates' | 'sshStateByEnvironment'>,
  route: WorktreeOperationRoute,
  authority?: HostAuthority
): number | undefined {
  const host = parseExecutionHostId(authority?.at ?? route.executionHostId)
  if (host?.kind !== 'ssh') {
    return undefined
  }
  try {
    return captureDirectSshMutationExpectation(state, host.targetId, route.runtimeEnvironmentId)
      .expectedSshConnectionGeneration
  } catch {
    return undefined
  }
}
