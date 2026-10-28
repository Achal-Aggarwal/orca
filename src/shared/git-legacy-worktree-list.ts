import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import type { GitAdminReadOptions } from './git-common-directory'
import { createGitHeadIdentityReader, UNREADABLE_GIT_HEAD } from './git-head-identity-reader'
import { resolveWorktreeHostPath } from './git-metadata-path'
import {
  annotateWorktreeLocksFromDirectories,
  readWorktreeAdminDirectories,
  worktreeAdminHostPathKey
} from './git-worktree-admin'
import { parseWorktreeList } from './git-worktree-porcelain-parser'
import { mapWithConcurrency } from './map-with-concurrency'
import { toLinuxPath, toWslExecutionSpace } from './wsl-paths'
import type { GitWorktreeInfo } from './worktree/types'

export async function reconcileLegacyWorktreeListFromAdmin(
  repoPath: string,
  output: string,
  worktrees: GitWorktreeInfo[],
  options: GitAdminReadOptions = {}
): Promise<GitWorktreeInfo[]> {
  const directories = await readWorktreeAdminDirectories(repoPath, options, true)
  const commonDir = directories[0].gitDir
  const physicalCommonDir = await waitForPromiseWithSignal(realpath(commonDir), options.signal)
  const candidates = [commonDir, physicalCommonDir].flatMap((gitDir) => [
    gitDir,
    ...(path.basename(gitDir) === '.git' ? [path.dirname(gitDir)] : [])
  ])
  const primaryPath = candidates
    .flatMap((hostPath) =>
      [
        hostPath,
        toWslExecutionSpace(hostPath),
        ...(isWindowsAbsolutePathLike(hostPath)
          ? [hostPath.replace(/\\/g, '/'), toLinuxPath(hostPath)]
          : [])
      ].map((serializedPath) => ({ hostPath, serializedPath }))
    )
    .sort((left, right) => right.serializedPath.length - left.serializedPath.length)
    .find(
      ({ serializedPath }) =>
        output.startsWith(`worktree ${serializedPath}\n`) ||
        output.startsWith(`worktree ${serializedPath}\r\n`)
    )
  if (!primaryPath) {
    throw new Error('Cannot verify the primary legacy worktree path.')
  }
  const fields = output
    .slice(`worktree ${primaryPath.serializedPath}`.length)
    .replace(/^\r?\n/, '')
    .split(/\r?\n\r?\n/, 1)[0]
  // Consume the proven full path before parsing fields: the path can itself contain record syntax.
  const primary = parseWorktreeList(`worktree primary\n${fields}\n\n`)[0]
  if (!primary) {
    throw new Error('Cannot verify the primary legacy worktree record.')
  }
  primary.path = primaryPath.serializedPath
  const linkedDirectories = directories.filter((entry) => !entry.isMain)
  const expectedPaths = [
    primaryPath.hostPath,
    ...linkedDirectories.flatMap((entry) => entry.worktreePath ?? [])
  ]
  const expected = new Set(expectedPaths.map(worktreeAdminHostPathKey))
  const seen = new Set(
    worktrees.map((entry) =>
      worktreeAdminHostPathKey(resolveWorktreeHostPath(entry.path, options) ?? entry.path)
    )
  )
  const exact =
    !expectedPaths.some((entry) => /[\r\n]/.test(entry)) &&
    expected.size === expectedPaths.length &&
    seen.size === worktrees.length &&
    seen.size === expected.size &&
    [...seen].every((entry) => expected.has(entry))
  if (exact) {
    return annotateWorktreeLocksFromDirectories(
      directories,
      worktrees.map((entry) => (entry.isMainWorktree ? primary : entry)),
      options
    )
  }

  const reader = createGitHeadIdentityReader(commonDir, options.signal)
  const linked = await mapWithConcurrency(
    linkedDirectories,
    8,
    async (entry): Promise<GitWorktreeInfo> => {
      if (
        !entry.worktreePath ||
        !entry.gitFilePath ||
        path.basename(entry.gitFilePath) !== '.git'
      ) {
        throw new Error('Cannot verify a legacy linked worktree path.')
      }
      const identity = await reader.read(path.join(entry.gitDir, 'HEAD'), entry.worktreePath)
      if (identity === null || identity === UNREADABLE_GIT_HEAD) {
        throw new Error('Cannot verify a legacy linked worktree HEAD.')
      }
      return {
        path: entry.worktreePath,
        head: identity.head,
        branch: identity.branch ?? '',
        isBare: false,
        isMainWorktree: false
      }
    }
  )
  const paths = linked.map((entry) => worktreeAdminHostPathKey(entry.path))
  if (
    new Set(paths).size !== paths.length ||
    paths.includes(worktreeAdminHostPathKey(primaryPath.hostPath))
  ) {
    throw new Error('Cannot verify duplicate legacy worktree paths.')
  }
  linked.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  return annotateWorktreeLocksFromDirectories(directories, [primary, ...linked], options)
}
