import { resolveQualifiedFolderWorkspaceResult } from '../../../../shared/folder-workspace-execution-host'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { stat } from 'node:fs/promises'
import type { Store } from '../../../persistence'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import {
  resolveTerminalStartupCwdForWorkspace,
  type TerminalStartupCwdMissingDirFallback
} from '../../../../shared/terminal-startup-cwd'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  getResolvedFolderWorkspacePathStatus
} from '../../../project-groups/folder-workspace-path-status'
import {
  isWslMoveWorkspaceBlocked,
  WslMoveProjectFencedError
} from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { listLiveDaemonPtyIds } from '../../../daemon/daemon-provider-state'

/** WSL moves block new PTYs, but proven daemon reattach must survive reload; folder workspaces still require usable paths. */
export function assertWorkspaceAcceptsNewPty(
  store: Store | undefined,
  worktreeId: string | undefined,
  sessionId?: string,
  connectionId?: string | null
): Promise<void> | void {
  if (isWslMoveWorkspaceBlocked(store, worktreeId)) {
    return assertReattachesLiveSession(sessionId).then(() =>
      assertFolderWorkspacePtyPathUsable(store, worktreeId, connectionId)
    )
  }
  return assertFolderWorkspacePtyPathUsable(store, worktreeId, connectionId)
}

async function assertReattachesLiveSession(sessionId: string | undefined): Promise<void> {
  // An unanswered census is never proof the session lives, so it refuses.
  const live = sessionId ? await listLiveDaemonPtyIds() : null
  if (!sessionId || !live?.includes(sessionId)) {
    throw new WslMoveProjectFencedError()
  }
}

export function assertFolderWorkspacePtyPathUsable(
  store: Store | undefined,
  worktreeId: string | undefined,
  connectionId?: string | null
): Promise<void> | void {
  const workspaceScope = typeof worktreeId === 'string' ? parseWorkspaceKey(worktreeId) : null
  if (!store || workspaceScope?.type !== 'folder') {
    return
  }
  const selected = resolveSpawnFolder(store, workspaceScope.folderWorkspaceId, connectionId)
  if (selected.kind === 'missing') {
    throw new Error('folder_workspace_path_scope_not_found')
  }
  return (
    selected.kind === 'selected'
      ? getResolvedFolderWorkspacePathStatus(selected.value.workspace, selected.value.hostId)
      : getFolderWorkspacePathStatus(store, {
          scope: 'folder-workspace',
          folderWorkspaceId: workspaceScope.folderWorkspaceId
        })
  ).then(assertFolderWorkspacePathUsable)
}

export function resolvePtySpawnStartupCwd(
  store: Store | undefined,
  worktreeId: string | undefined,
  cwd: string | undefined,
  missingDirFallback?: TerminalStartupCwdMissingDirFallback,
  connectionId?: string | null
): string | undefined {
  return resolveTerminalStartupCwdForWorkspace({
    workspaceId: worktreeId,
    requestedCwd: cwd,
    missingDirFallback,
    resolveFolderWorkspacePath: (folderWorkspaceId) =>
      store
        ? (() => {
            const result = resolveQualifiedFolderWorkspaceResult(
              {
                folderWorkspaces: store.getFolderWorkspaces(),
                projectGroups: store.getProjectGroups(),
                repos: store.getRepos()
              },
              folderWorkspaceId,
              getConnectionExecutionHostId(connectionId)
            )
            return result.kind === 'selected' ? result.value.workspace.folderPath : undefined
          })()
        : undefined
  })
}

function resolveSpawnFolder(store: Store, id: string, connectionId?: string | null) {
  return resolveQualifiedFolderWorkspaceResult(
    {
      folderWorkspaces: store.getFolderWorkspaces(),
      projectGroups: store.getProjectGroups(),
      repos: store.getRepos()
    },
    id,
    getConnectionExecutionHostId(connectionId)
  )
}

export async function localStartupCwdDirectoryExists(path: string): Promise<boolean> {
  // Win32 9P stat can falsely report WSL-share absence; defer to WSL-aware provider validation.
  if (isWslUncPath(path)) {
    return true
  }
  // A dead network mount must not block main's event loop.
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
