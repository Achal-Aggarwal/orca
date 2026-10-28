import { useAppStore } from '@/store'
import type { DirEntry } from '../../../shared/filesystem-entry-types'
import type { DirEntryPage } from '../../../shared/file-dir-page'
import { FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY } from '../../../shared/files-runtime-capabilities'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../shared/runtime-host-status'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import { getRemoteFileArgs } from './runtime-file-routing'
import { callRuntimeRpc } from './runtime-rpc-client'
import { readRuntimeDirectory } from './runtime-file-mutation-client'

function hostServesDirPages(environmentId: string): boolean {
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  return (
    !isRuntimeHostContactRevoked(entry) &&
    lastVerifiedRuntimeStatus(entry)?.capabilities?.includes(
      FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY
    ) === true
  )
}

function wholeFolderFrom(entries: DirEntry[], offset: number): DirEntryPage {
  return { entries: offset === 0 ? entries : entries.slice(offset), total: entries.length }
}

/** True where `dirPath` is on a remote server that serves folders in pages. */
export function runtimeDirectoryPagesSupported(
  context: RuntimeFileOperationArgs,
  dirPath: string
): boolean {
  const remoteArgs = getRemoteFileArgs(context, dirPath)
  return remoteArgs !== null && hostServesDirPages(remoteArgs.target.environmentId)
}

/**
 * One page of a remote server's folder. Where the folder is local, over SSH, or on a host too old
 * to page, it returns every entry from `offset`, so `total` is always reached.
 */
export async function readRuntimeDirectoryPage(
  context: RuntimeFileOperationArgs,
  dirPath: string,
  page: { offset: number; limit: number },
  options: { followSymlinks?: boolean; wakeWslDistro?: boolean } = {}
): Promise<DirEntryPage> {
  const remoteArgs = getRemoteFileArgs(context, dirPath)
  if (!remoteArgs || !hostServesDirPages(remoteArgs.target.environmentId)) {
    return wholeFolderFrom(await readRuntimeDirectory(context, dirPath, options), page.offset)
  }
  const result = await callRuntimeRpc<DirEntryPage | DirEntry[]>(
    remoteArgs.target,
    'files.readDir',
    {
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath,
      ...(options.followSymlinks === undefined ? {} : { followSymlinks: options.followSymlinks }),
      offset: page.offset,
      limit: page.limit
    },
    { timeoutMs: 15_000 }
  )
  // Why: a host replaced by an older build since its status was read ignores the page fields.
  return Array.isArray(result) ? wholeFolderFrom(result, page.offset) : result
}
