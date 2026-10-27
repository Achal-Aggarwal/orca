import { getConnectionIdForFile } from '@/lib/connection-context'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import { acquireEditorFileOperation } from '@/lib/editor-file-operation-owner'
import type { OpenFile } from '@/store/slices/editor'

export function acquireCombinedDiffSectionOperation(file: OpenFile, sectionPath: string) {
  return acquireEditorFileOperation(useAppStore.getState, file, {
    filePath: joinPath(file.filePath, sectionPath),
    worktreePath: file.filePath
  })
}

/**
 * Resolve the SSH connectionId that owns a combined-diff section's file.
 *
 * Why: folder workspaces mix local and SSH child repos, so the workspace
 * worktree is an ambiguous owner; the section must resolve its host by the
 * concrete child-repo path or a remote read is misrouted locally (#6688).
 */
export function getCombinedDiffSectionConnectionId(
  worktreeId: string | null,
  worktreeRootPath: string,
  sectionPath: string
): string | undefined {
  return getConnectionIdForFile(worktreeId, joinPath(worktreeRootPath, sectionPath)) ?? undefined
}
