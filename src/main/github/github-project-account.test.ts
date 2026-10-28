import { afterEach, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import {
  ghRepoExecOptions,
  githubRepoContext,
  withGitHubRepoExecution
} from './github-repository-identity'
import { installGitHubProjectAccounts } from './github-project-account'
import { githubReadExecutionScope } from './github-read-execution-scope'
import { resolveGitHubRepoExecution } from './github-api-repository'

let release: (() => void) | undefined
afterEach(() => release?.())
const alice = { host: 'github.com', user: 'Alice' }
const bob = { host: 'github.com', user: 'Bob' }
function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0,
    ghAccount: alice,
    ...overrides
  }
}
function options(path: string, connectionId?: string | null, extra = {}) {
  return ghRepoExecOptions(githubRepoContext(path, connectionId, extra))
}

it('uses the saved bound or unbound selection over stale caller options, and isolates cache keys', () => {
  let current = repo()
  release = installGitHubProjectAccounts({ getRepos: () => [current] })
  const first = options('/repo', null, { ghAccount: bob })
  expect(first.ghAccount).toEqual(alice)
  current = repo({ ghAccount: bob })
  const second = options('/repo', null, { ghAccount: alice })
  expect(second.ghAccount).toEqual(bob)
  expect(githubReadExecutionScope(first, {})).not.toBe(githubReadExecutionScope(second, {}))
  current = repo({ ghAccount: undefined })
  expect(options('/repo', null, { ghAccount: alice }).ghAccount).toBeUndefined()
  expect(first.ghAccount).toEqual(alice)
})

it.each(['cold', 'warm'] as const)(
  'resolves a %s child worktree by its host-qualified owning project',
  (mode) => {
    const local = repo()
    const remote = repo({ path: '/repo', connectionId: 'server', ghAccount: bob })
    release = installGitHubProjectAccounts(
      {
        getRepos: () => [local, remote],
        getAllWorktreeMetaForHost: (host) =>
          mode === 'cold' && host === 'ssh:server' ? { 'repo::/worktrees/child': {} } : {}
      },
      () =>
        mode === 'warm' ? [{ repoId: 'repo', path: '/worktrees/child', hostId: 'ssh:server' }] : []
    )
    expect(options('/worktrees/child', 'server')).toEqual({ ghAccount: bob })
    expect(options('/worktrees/child')).toEqual({ cwd: '/worktrees/child' })
    expect(options('/repo').ghAccount).toEqual(alice)
    expect(options('/repo', 'server').ghAccount).toEqual(bob)
  }
)

it('preserves explicit options on ownership misses without adding a refusal', () => {
  release = installGitHubProjectAccounts({ getRepos: () => [repo()] })
  expect(options('/unseen-worktree', null, { ghAccount: bob })).toMatchObject({ ghAccount: bob })
  expect(options('/unseen-worktree')).toEqual({ cwd: '/unseen-worktree' })
})

it('uses WSL namespace and Windows path spelling without merging POSIX case', () => {
  release = installGitHubProjectAccounts({
    getRepos: () => [
      repo({ path: String.raw`\\wsl.localhost\Ubuntu\home\work` }),
      repo({ id: 'win', path: String.raw`C:\Work`, ghAccount: bob })
    ]
  })
  expect(options('/home/work', null, { wslDistro: 'ubuntu' }).ghAccount).toEqual(alice)
  expect(options('/home/Work', null, { wslDistro: 'Ubuntu' }).ghAccount).toBeUndefined()
  expect(options('/home/work', null, { wslDistro: 'Debian' }).ghAccount).toBeUndefined()
  expect(options('c:/work/').ghAccount).toEqual(bob)
})

it('keeps folder cards on their git child account and plain folders outside project gh selection', () => {
  release = installGitHubProjectAccounts({
    getRepos: () => [
      repo({ id: 'folder', path: '/folder', kind: 'folder' }),
      repo({ id: 'child', path: '/folder/repo', ghAccount: bob })
    ]
  })
  expect(options('/folder/repo').ghAccount).toEqual(bob)
  expect(options('/folder').ghAccount).toBeUndefined()
})

it('isolates concurrent operations and ends their immutable account snapshots', async () => {
  let current = repo()
  release = installGitHubProjectAccounts({ getRepos: () => [current] })
  let resume: () => void = () => {}
  const waiting = new Promise<void>((resolve) => {
    resume = resolve
  })
  const pending = withGitHubRepoExecution('/repo', null, {}, async () => {
    expect(Object.isFrozen(githubRepoContext('/repo'))).toBe(true)
    await waiting
    return options('/repo')
  })
  current = repo({ ghAccount: bob })
  expect(options('/repo').ghAccount).toEqual(bob)
  resume()
  expect((await pending).ghAccount).toEqual(alice)
  expect(options('/repo').ghAccount).toEqual(bob)
})

it('does not let an earlier owner release a replacement installation', () => {
  const previous = installGitHubProjectAccounts({ getRepos: () => [repo()] })
  release = installGitHubProjectAccounts({ getRepos: () => [repo({ ghAccount: bob })] })
  previous()
  expect(options('/repo').ghAccount).toEqual(bob)
  installGitHubProjectAccounts(null)
  expect(options('/repo').ghAccount).toBeUndefined()
})

it('selects before an asynchronous repository lookup and retains that account for execution', async () => {
  let current = repo()
  release = installGitHubProjectAccounts({ getRepos: () => [current] })
  let finish: () => void = () => {}
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  const pending = resolveGitHubRepoExecution('/repo', async () => {
    await waiting
    return { owner: 'acme', repo: 'widgets', host: 'github.com' }
  })
  current = repo({ ghAccount: bob })
  finish()
  expect((await pending).ghOptions.ghAccount).toEqual(alice)
  expect(options('/repo').ghAccount).toEqual(bob)
})
