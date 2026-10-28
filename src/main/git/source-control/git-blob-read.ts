import * as path from 'node:path'
import {
  NodeFileNotRegularError,
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../../shared/node-bounded-file-reader'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import { isMissingGitBlobPath } from '../../../shared/git-blob-absence'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsyncBuffer } from '../runner'
import { isMaxBufferOverflowError } from '../max-buffer-overflow'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'
import { PREVIEWABLE_BINARY_MIME_TYPES } from './previewable-binary-mime-types'

export type GitBlobReadResult = {
  content: string
  isBinary: boolean
  exists: boolean
  /** Unknown presence: never cache a diff whose empty side came from an incomplete read. */
  failed?: boolean
}

export async function readUnstagedLeftBlob(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  const indexBlob = await readGitBlobAtIndexPath(worktreePath, filePath, options)
  if (indexBlob.exists || indexBlob.failed) {
    return indexBlob
  }

  return readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
}

export async function readGitBlobAtIndexPath(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Git blob syntax requires forward slashes, including on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(['show', `:${gitPath}`], {
      ...gitReadOptionsForWorktree(worktreePath, options),
      maxBuffer: MAX_GIT_SHOW_BYTES
    })

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    return {
      content: '',
      isBinary: false,
      exists: false,
      failed: !isMissingGitBlobPath(error, gitPath)
    }
  }
}

export async function readGitBlobAtOidPath(
  worktreePath: string,
  oid: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Git blob syntax requires forward slashes, including on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(
      ['show', '--end-of-options', `${oid}:${gitPath}`],
      {
        ...gitReadOptionsForWorktree(worktreePath, options),
        maxBuffer: MAX_GIT_SHOW_BYTES
      }
    )

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    return {
      content: '',
      isBinary: false,
      exists: false,
      failed: !isMissingGitBlobPath(error, gitPath, oid)
    }
  }
}

export async function readWorkingTreeFile(filePath: string): Promise<GitBlobReadResult> {
  try {
    const { buffer } = await readNodeFileWithinLimit(filePath, MAX_GIT_SHOW_BYTES, {
      regularFileOnly: true
    })
    return bufferToBlob(buffer, filePath)
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      return { content: '', isBinary: true, exists: true }
    }
    if (error instanceof NodeFileNotRegularError) {
      return { content: '', isBinary: false, exists: false }
    }
    // Only ENOENT proves deletion; other read errors leave presence unknown.
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
    return { content: '', isBinary: false, exists: !missing, ...(missing ? {} : { failed: true }) }
  }
}

function bufferToBlob(buffer: Buffer, filePath?: string): GitBlobReadResult {
  const isBinary = isBinaryBuffer(buffer)
  // Encode previewable binaries for the renderer.
  const isPreviewableBinary = filePath
    ? !!PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
    : false
  return {
    content: isBinary
      ? isPreviewableBinary
        ? buffer.toString('base64')
        : ''
      : buffer.toString('utf-8'),
    isBinary,
    exists: true
  }
}
