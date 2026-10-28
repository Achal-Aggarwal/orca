import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import { parseGitdirMarkerPayload } from '../../shared/gitdir-marker-payload'
import { resolveGitDirectoryPath } from '../../shared/git-metadata-path'

export async function resolveWorktreeCommonGitDirectory(repo: Repo): Promise<string | null> {
  const dotGitPath = join(repo.path, '.git')
  try {
    const dotGitStat = await stat(dotGitPath)
    if (dotGitStat.isDirectory()) {
      return dotGitPath
    }
    if (!dotGitStat.isFile()) {
      return null
    }
    const content = await readFile(dotGitPath, 'utf8')
    const payload = parseGitdirMarkerPayload(content)
    const resolvedGitDir = payload && resolveGitDirectoryPath(repo.path, payload)
    if (!resolvedGitDir) {
      return null
    }
    return basename(dirname(resolvedGitDir)) === 'worktrees'
      ? dirname(dirname(resolvedGitDir))
      : resolvedGitDir
  } catch (error) {
    console.warn(`[worktree-base-watcher] cannot resolve git common dir for ${repo.id}:`, error)
    return null
  }
}
