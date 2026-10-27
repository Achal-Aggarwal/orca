import type { Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { getRepoHostIdentityForParts } from '../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import {
  createWorktreeVisibilitySourceMatcher,
  type WorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'

export function buildRuntimeWorktreeVisibilityMatchers(
  repos: readonly Repo[],
  resolved: readonly ResolvedWorktree[],
  visibilityDefaults: Parameters<typeof resolveCustomWorktreeVisibilitySources>[1]
) {
  const pathsByRepo = new Map<string, string[]>()
  for (const worktree of resolved) {
    const paths =
      pathsByRepo.get(getRepoHostIdentityForParts(worktree.repoId, worktree.hostId ?? 'local')) ??
      []
    paths.push(worktree.path)
    pathsByRepo.set(getRepoHostIdentityForParts(worktree.repoId, worktree.hostId ?? 'local'), paths)
  }
  return new Map(
    repos.map((repo) => [
      getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo)),
      createWorktreeVisibilitySourceMatcher(
        [
          repo.path,
          ...(pathsByRepo.get(getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))) ??
            [])
        ],
        resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
        resolveConfiguredWorktreeBasePaths(repo)
      )
    ])
  )
}

export function buildRuntimeWorktreeVisibilityMatchersByRepoId(
  repos: readonly Repo[],
  worktrees: readonly Worktree[],
  visibilityDefaults: Parameters<typeof resolveCustomWorktreeVisibilitySources>[1]
): Map<string, WorktreeVisibilitySourceMatcher> {
  const checkoutPathsByRepoId = new Map<string, string[]>()
  for (const worktree of worktrees) {
    const checkoutPaths = checkoutPathsByRepoId.get(worktree.repoId) ?? []
    checkoutPaths.push(worktree.path)
    checkoutPathsByRepoId.set(worktree.repoId, checkoutPaths)
  }
  return new Map(
    repos
      .filter((repo) => checkoutPathsByRepoId.has(repo.id))
      .map((repo) => [
        repo.id,
        createWorktreeVisibilitySourceMatcher(
          [repo.path, ...(checkoutPathsByRepoId.get(repo.id) ?? [])],
          resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
          resolveConfiguredWorktreeBasePaths(repo)
        )
      ])
  )
}
