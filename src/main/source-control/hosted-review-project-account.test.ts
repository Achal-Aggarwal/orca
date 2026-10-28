import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { installGitHubProjectAccounts } from '../github/github-project-account'
import { __resetHostedReviewBranchCacheForTests } from './hosted-review-branch-cache'
import { getHostedReviewForBranch } from './hosted-review'

const { read, detect } = vi.hoisted(() => ({ read: vi.fn(), detect: vi.fn() }))
vi.mock('./forge-provider', () => ({ getForgeProviderForRepository: detect }))
let release: () => void
let repo: Repo
beforeEach(() => {
  __resetHostedReviewBranchCacheForTests()
  read.mockReset()
  detect.mockReset().mockResolvedValue({ id: 'github', getReviewForBranch: read })
  repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0,
    ghAccount: { host: 'github.com', user: 'Alice' }
  }
  release = installGitHubProjectAccounts({ getRepos: () => [repo] })
})
afterEach(() => release())

it('does not reuse a negative review result after the saved account changes or clears', async () => {
  read.mockResolvedValue(null)
  const input = { repoPath: '/repo', executionHostId: 'local', branch: 'feature' } as const
  await getHostedReviewForBranch(input)
  await getHostedReviewForBranch(input)
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls[0][0].localGitExecOptions.ghAccount.user).toBe('Alice')
  repo = { ...repo, ghAccount: { host: 'github.com', user: 'Bob' } }
  await getHostedReviewForBranch(input)
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[1][0].localGitExecOptions.ghAccount.user).toBe('Bob')
  repo = { ...repo, ghAccount: undefined }
  await getHostedReviewForBranch(input)
  expect(read).toHaveBeenCalledTimes(3)
  expect(read.mock.calls[2][0].localGitExecOptions.ghAccount).toBeUndefined()
})

it('leaves other providers outside GitHub account selection', async () => {
  detect.mockResolvedValue({ id: 'gitlab', getReviewForBranch: read })
  read.mockResolvedValue(null)
  await getHostedReviewForBranch({ repoPath: '/repo', executionHostId: 'local', branch: 'feature' })
  expect(read.mock.calls[0][0].localGitExecOptions).toBeUndefined()
})
