import type { Repo } from '../../shared/repo-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getConnectionExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { normalizeGhAccountBinding } from '../../shared/github/account-binding'
import { isGitRepoKind } from '../../shared/repo-kind'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  resolveLocalProjectRuntimeForRepo,
  type ProjectRuntimeResolutionStore
} from '../local-project-runtime-resolution'
import { getStoredRepoExecutionHostId } from '../repo-execution-host'
import type { GitHubRepoContext } from './github-repository-identity'

type AccountStore = ProjectRuntimeResolutionStore & {
  getRepos: () => readonly Repo[]
  getAllWorktreeMetaForHost?: (hostId: ExecutionHostId) => Record<string, unknown>
}
type KnownWorktree = { repoId: string; path: string; hostId?: ExecutionHostId }
let source: { store: AccountStore; worktrees: () => readonly KnownWorktree[] } | null = null

export function installGitHubProjectAccounts(
  store: AccountStore | null,
  worktrees: () => readonly KnownWorktree[] = () => []
): () => void {
  const installed = store ? { store, worktrees } : null
  source = installed
  return () => {
    if (source === installed) {
      source = null
    }
  }
}

function pathKey(path: string, distro?: string): string {
  const unc = parseWslUncPath(path)
  const runtime = (unc?.distro ?? distro)?.toLowerCase() ?? ''
  return `${runtime}\0${normalizeRuntimePathForComparison(unc?.linuxPath ?? path)}`
}

/** A recognized unbound project differs from a path with no known owner. */
export function resolveGitHubProjectAccount(context: GitHubRepoContext) {
  if (!source) {
    return null
  }
  const { store, worktrees } = source
  const hostId = getConnectionExecutionHostId(context.connectionId)
  const key = pathKey(context.repoPath, context.connectionId ? undefined : context.wslDistro)
  const repos = store
    .getRepos()
    .filter((repo) => isGitRepoKind(repo) && getStoredRepoExecutionHostId(repo) === hostId)
  const repoDistro = (repo: Repo): string | undefined => {
    if (context.connectionId) {
      return undefined
    }
    const runtime = resolveLocalProjectRuntimeForRepo(store, repo)
    return runtime?.status === 'resolved' && runtime.runtime.kind === 'wsl'
      ? runtime.runtime.distro
      : parseWslUncPath(repo.path)?.distro
  }
  let matches = repos.filter((repo) => pathKey(repo.path, repoDistro(repo)) === key)
  if (!matches.length) {
    const owners = new Set(
      worktrees()
        .filter(
          (worktree) =>
            getStoredRepoExecutionHostId({ executionHostId: worktree.hostId }) === hostId &&
            repos.some(
              (repo) =>
                repo.id === worktree.repoId && pathKey(worktree.path, repoDistro(repo)) === key
            )
        )
        .map((worktree) => worktree.repoId)
    )
    // Persisted workspace identities cover cold starts without starting a Git scan.
    for (const id of Object.keys(store.getAllWorktreeMetaForHost?.(hostId) ?? {})) {
      const parsed = splitWorktreeIdForFilesystem(id)
      if (
        parsed &&
        repos.some(
          (repo) =>
            repo.id === parsed.repoId && pathKey(parsed.worktreePath, repoDistro(repo)) === key
        )
      ) {
        owners.add(parsed.repoId)
      }
    }
    matches = repos.filter((repo) => owners.has(repo.id))
  }
  return matches.length === 1
    ? { ghAccount: normalizeGhAccountBinding(matches[0].ghAccount) ?? undefined }
    : null
}
