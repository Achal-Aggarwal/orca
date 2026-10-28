import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'
import { gitDiffReadLeaseOwner } from './git-read-cache-invalidation'
import { buildDiffResult } from './diff-result'
import { readGitBlobAtOidPath } from './git-blob-read'

export async function getBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions = {}
): Promise<GitDiffResult> {
  return gitDiffReadLeaseOwner.lease(
    stableInFlightKey([
      'branchDiff',
      worktreePath,
      args.headOid,
      args.mergeBase,
      args.filePath,
      args.oldPath ?? null,
      ...gitRuntimeOptionsKey(options)
    ]),
    options.signal,
    (signal) => loadBranchDiff(worktreePath, args, { ...options, signal })
  )
}

async function loadBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  try {
    const leftPath = args.oldPath ?? args.filePath
    // Read independent blobs concurrently to avoid doubling diff latency.
    const [leftBlob, rightBlob] = await Promise.all([
      readGitBlobAtOidPath(worktreePath, args.mergeBase, leftPath, options),
      readGitBlobAtOidPath(worktreePath, args.headOid, args.filePath, options)
    ])

    return buildDiffResult(
      leftBlob.content,
      rightBlob.content,
      leftBlob.isBinary,
      rightBlob.isBinary,
      args.filePath,
      leftBlob.tooLarge === true || rightBlob.tooLarge === true
    )
  } catch {
    options.signal?.throwIfAborted()
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}
