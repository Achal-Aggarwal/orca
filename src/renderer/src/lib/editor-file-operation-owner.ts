import {
  captureEditorFileOperationProvenance,
  assertEditorFileOperationCurrent,
  getExpectedSshConnectionGeneration,
  OWNER_CHANGED_MESSAGE,
  type EditorFileOperationProvenance
} from './editor-file-operation-provenance'
export {
  captureEditorFileOperationProvenance,
  assertEditorFileOperationCurrent,
  resolveEditorOwnerRoute,
  type EditorFileOperationProvenance
} from './editor-file-operation-provenance'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { HostAuthority } from '../../../shared/host-authority'
import { resolveWorkspaceDirectory } from './workspace-directory'
import { getFileConnectionOwnerFromState } from './connection-owner-resolution'
import {
  assertWorktreeOperationGenerationSnapshotCurrent,
  captureWorktreeOperationGenerationSnapshot
} from './worktree-operation-generation'
import type { WorktreeOperationRoute } from './worktree-operation-route'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

export function getEditorFileOperationContext(
  ...args: Parameters<typeof getEditorFileReadContext>
) {
  const context = getEditorFileReadContext(...args)
  if (
    !context.expectedExecutionHostId ||
    (context.expectedSshTargetId && context.expectedSshConnectionGeneration === undefined)
  ) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  return { ...context, expectedExecutionHostId: context.expectedExecutionHostId }
}

export function getEditorFileReadContext(
  state: AppState,
  file: {
    worktreeId: string
    runtimeEnvironmentId?: string | null
    externalSshTargetId?: string
    operationProvenance?: EditorFileOperationProvenance
  },
  worktreePath: string | null
): {
  target: RuntimeClientTarget
  worktreeId: string
  worktreePath: string | null
  connectionId?: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExecutionHostId?: 'local' | `ssh:${string}`
} {
  const provenance =
    file.operationProvenance ??
    captureEditorFileOperationProvenance(
      state,
      file.worktreeId,
      file.runtimeEnvironmentId,
      file.runtimeEnvironmentId !== undefined
    )
  const route = file.operationProvenance
    ? assertEditorFileOperationCurrent(state, file.worktreeId, provenance)
    : provenance.generation.route
  const workspaceScope = parseWorkspaceKey(file.worktreeId)
  const resolvedWorktreePath =
    (worktreePath?.trim() ? worktreePath : null) ??
    (workspaceScope?.type === 'folder'
      ? resolveWorkspaceDirectory(state, file.worktreeId, route.executionHostId)
      : null)
  return editorFileReadContext(file, provenance, resolvedWorktreePath)
}

function editorFileReadContext(
  file: Parameters<typeof getEditorFileReadContext>[1],
  provenance: EditorFileOperationProvenance,
  resolvedWorktreePath: string | null
) {
  const route = provenance.generation.route
  const host = parseExecutionHostId(provenance.generation.authority?.at ?? route.executionHostId)
  const externalSshTargetId = file.externalSshTargetId?.trim()
  if (
    externalSshTargetId &&
    (host?.kind !== 'ssh' ||
      route.runtimeEnvironmentId !== null ||
      host.targetId !== externalSshTargetId)
  ) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  return {
    target: runtimeTargetForOwnerEnvironment(route.runtimeEnvironmentId),
    worktreeId: file.worktreeId,
    worktreePath: resolvedWorktreePath,
    ...(host
      ? { expectedExecutionHostId: host.kind === 'ssh' ? host.id : ('local' as const) }
      : {}),
    ...(route.runtimeEnvironmentId === null && host?.kind === 'ssh'
      ? { connectionId: host.targetId }
      : {}),
    ...(host?.kind === 'ssh' ? { expectedSshTargetId: host.targetId } : {}),
    ...(provenance.expectedSshConnectionGeneration === undefined
      ? {}
      : { expectedSshConnectionGeneration: provenance.expectedSshConnectionGeneration })
  }
}

export function isSameEditorFileOperationIdentity(file: OpenFile, live: OpenFile): boolean {
  return (
    file.id === live.id &&
    file.worktreeId === live.worktreeId &&
    file.filePath === live.filePath &&
    file.relativePath === live.relativePath &&
    file.mode === live.mode &&
    file.runtimeEnvironmentId === live.runtimeEnvironmentId &&
    file.externalSshTargetId === live.externalSshTargetId &&
    (!file.operationProvenance || file.operationProvenance === live.operationProvenance)
  )
}

export function acquireEditorFileOperation(
  getState: () => AppState,
  file: OpenFile,
  resource?: { filePath: string; worktreePath: string | null }
) {
  const selectChild = (state: AppState) =>
    getFileConnectionOwnerFromState(state, file.worktreeId, resource?.filePath ?? file.filePath)
      ?.repo
  const child = selectChild(getState())
  const selectedFile = child
    ? getState().openFiles.find((live) => isSameEditorFileOperationIdentity(file, live))
    : getState().acquireEditorFileOperationProvenance(file)
  if (!selectedFile) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  const state = getState()
  const childRoute = (repo: typeof child): WorktreeOperationRoute | null => {
    if (!repo) {
      return null
    }
    const executionHostId = getRepoExecutionHostId(repo)
    const host = parseExecutionHostId(executionHostId)
    return {
      executionHostId,
      runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
    }
  }
  const route = childRoute(child)
  const childAuthority = (repo: typeof child): HostAuthority | undefined => {
    const selected = childRoute(repo)
    if (!selected || !repo) {
      return undefined
    }
    const ssh = getRepoSshConnectionId(repo)
    return {
      endpoint: selected.runtimeEnvironmentId
        ? { kind: 'environment', environmentId: selected.runtimeEnvironmentId }
        : { kind: 'self' },
      at: ssh ? `ssh:${encodeURIComponent(ssh)}` : 'local'
    }
  }
  const selectedProvenance = route
    ? {
        generation: captureWorktreeOperationGenerationSnapshot(route, childAuthority(child)),
        ownershipProjection: 'explicit' as const,
        expectedSshConnectionGeneration: getExpectedSshConnectionGeneration(
          state,
          route,
          childAuthority(child)
        )
      }
    : undefined
  const captured =
    child && !resource
      ? getState().acquireEditorFileOperationProvenance(selectedFile, selectedProvenance)
      : selectedFile
  const provenance =
    resource && resource.filePath !== captured.filePath
      ? (selectedProvenance ?? captured.operationProvenance)
      : (captured.operationProvenance ?? selectedProvenance)
  if (
    !provenance ||
    (child &&
      captured.runtimeEnvironmentId !== undefined &&
      captured.runtimeEnvironmentId !== provenance.generation.route.runtimeEnvironmentId)
  ) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  const resolveOwnerDirectory = (current: AppState): string | null => {
    const qualified = resolveWorkspaceDirectory(
      current,
      captured.worktreeId,
      provenance.generation.route.executionHostId
    )
    if (qualified || provenance.ownershipProjection !== 'legacy') {
      return qualified
    }
    const paths = new Set(
      [
        ...Object.values(selectWorktreesByRepo(current) ?? {}).flat(),
        ...Object.values(selectDetectedWorktreesByRepo(current) ?? {}).flatMap(
          (listing) => listing.worktrees
        )
      ]
        .filter((row) => row.id === captured.worktreeId)
        .map((row) => row.path || null)
    )
    return paths.size === 1 ? (paths.values().next().value ?? null) : null
  }
  const ownerDirectory = resolveOwnerDirectory(state)
  const directory = resource?.worktreePath ?? ownerDirectory
  const context = editorFileReadContext(captured, provenance, directory)
  const assertAuthorityCurrent = (): void => {
    const current = getState()
    if (child) {
      const liveChild = selectChild(current)
      if (!liveChild || liveChild.id !== child.id || liveChild.path !== child.path) {
        throw new Error(OWNER_CHANGED_MESSAGE)
      }
      assertWorktreeOperationGenerationSnapshotCurrent(
        getState,
        captured.worktreeId,
        provenance.generation,
        () => new Error(OWNER_CHANGED_MESSAGE),
        () => childRoute(liveChild),
        () => childAuthority(liveChild)
      )
      if (
        getExpectedSshConnectionGeneration(
          current,
          provenance.generation.route,
          provenance.generation.authority
        ) !== provenance.expectedSshConnectionGeneration
      ) {
        throw new Error(OWNER_CHANGED_MESSAGE)
      }
    } else {
      assertEditorFileOperationCurrent(current, captured.worktreeId, provenance)
    }
    if (resolveOwnerDirectory(current) !== ownerDirectory) {
      throw new Error(OWNER_CHANGED_MESSAGE)
    }
  }
  const mutationContext = () => {
    if (
      !context.expectedExecutionHostId ||
      (context.expectedSshTargetId && context.expectedSshConnectionGeneration === undefined)
    ) {
      throw new Error(OWNER_CHANGED_MESSAGE)
    }
    return { ...context, expectedExecutionHostId: context.expectedExecutionHostId }
  }
  const assertCurrent = (): void => {
    const current = getState()
    const live = current.openFiles.find((candidate) => candidate.id === file.id)
    if (!live || !isSameEditorFileOperationIdentity(captured, live)) {
      throw new Error(OWNER_CHANGED_MESSAGE)
    }
    assertAuthorityCurrent()
  }
  assertCurrent()
  return {
    file: captured,
    provenance,
    context,
    mutationContext,
    assertAuthorityCurrent,
    assertCurrent
  }
}
