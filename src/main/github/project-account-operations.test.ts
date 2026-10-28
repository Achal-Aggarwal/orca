import type { createGitHubPullRequest } from './client/create/create-github-pull-request'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeSpawnedChild } from '../../shared/__fixtures__/fake-spawned-child'
import {
  createStore,
  closeTestStores,
  testState,
  makeRepo
} from '../persistence/persistence-test-harness'

const { spawnMock, remote } = vi.hoisted(() => ({ spawnMock: vi.fn(), remote: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('./github-api-repository-remote-probe', () => ({
  getOriginGitHubApiRepository: remote,
  getGitHubApiRepositoryForRemote: remote
}))
vi.mock('../git/remote-name-listing', () => ({ shouldProbeGitRemote: async () => false }))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: () => {},
  spendsSharedGitHubComQuota: () => false
}))
vi.mock('./client/list/work-item-search-page', () => ({ usesGraphqlWorkItemSearch: () => false }))
vi.mock('./client/lookup/pr-lookup-rate-limit', () => ({ assertRateLimitBudget: async () => {} }))

vi.mock('../source-control/forge-provider', () => ({
  detectHostedReviewProvider: async () => 'github',
  getForgeProviderForRepository: async () => ({
    id: 'github',
    getReviewForBranch: async () => null,
    createReview: async (...args: Parameters<typeof createGitHubPullRequest>) =>
      (await import('./client/create/create-github-pull-request')).createGitHubPullRequest(...args)
  })
}))
vi.mock('../source-control/hosted-review-creation-git-state', async (original) => ({
  ...(await original()),
  getCurrentBranch: async () => 'feature',
  hasUncommittedChanges: async () => false,
  getHostedReviewUpstreamStatus: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
  baseRefExistsOnRemote: async () => true,
  getDefaultBaseRef: async () => 'parent'
}))
vi.mock('../source-control/hosted-review-creation-provider', async (original) => ({
  ...(await original()),
  isProviderAuthenticated: async () => true
}))

import { installGitHubProjectAccounts } from './github-project-account'
import { getPRChecks } from './client/check/get-pr-checks'
import { rerunPRChecks } from './client/check/rerun-pr-checks'
import { getPRFileContents } from './work-item-details'
import { resolveGitHubPrStartPoint } from './pr-start-point'
import { RuntimeGitHubRepositoryQueryCommands } from '../runtime/runtime-github-repository-query-commands'
import { clearGhAccountTokenCacheForTests } from './gh-account-token'
import { clearGhCapabilityStateForTests } from './gh-capability-state'
import { _resetGhRateLimitBreaker } from '../git/gh-rate-limit-breaker'
import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { createStackedHostedReview } from '../source-control/stacked-hosted-review-creation'
import { hostedReviewOptionArgs } from './pr-refresh-candidate-policy'

const alice = { host: 'github.com', user: 'Alice' }
const bob = { host: 'github.com', user: 'Bob' }
const repository = { host: 'github.com', owner: 'acme', repo: 'widgets' }
let store: ReturnType<typeof createStore>
let release: () => void
let onRead: () => void
let requests: { args: string[]; token: string | undefined }[]
let request: (
  args: string[],
  child: ReturnType<typeof createFakeSpawnedChild>,
  token?: string
) => void
function complete(child: ReturnType<typeof createFakeSpawnedChild>, stdout: string) {
  child.stdout?.emit('data', Buffer.from(stdout))
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}
function checkResponse(name = 'CI') {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          name,
                          status: 'COMPLETED',
                          conclusion: 'FAILURE',
                          databaseId: 7,
                          checkSuite: { workflowRun: { databaseId: 99 } }
                        }
                      ]
                    }
                  }
                }
              }
            ]
          }
        }
      }
    }
  })
}
function issue(title: string) {
  return { number: 42, title, state: 'open', html_url: 'https://github.com/acme/widgets/issues/42' }
}
function pr(title: string) {
  return {
    number: 42,
    title,
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/pull/42',
    headRefName: 'feature',
    baseRefName: 'main',
    headRepositoryOwner: { login: 'acme' },
    headRepository: { name: 'widgets' },
    statusCheckRollup: [],
    mergeable: 'MERGEABLE'
  }
}
function rebind() {
  store.updateRepo({ id: 'work' }, { ghAccount: bob })
}
function rebindDuringFirstResolution() {
  let first = true
  onRead = () => {
    if (first) {
      first = false
      queueMicrotask(rebind)
    }
  }
}
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-pr35023-'))
  const original = createStore()
  original.addRepo(makeRepo({ id: 'work', path: '/work', issueSourcePreference: 'origin' }))
  original.updateRepo({ id: 'work' }, { ghAccount: { host: ' GitHub.COM ', user: ' Alice ' } })
  original.flush()
  store = createStore()
  expect(store.getRepo('work')?.ghAccount).toEqual(alice)
  clearGhAccountTokenCacheForTests()
  clearGhCapabilityStateForTests()
  _resetGhRateLimitBreaker()
  requests = []
  onRead = () => {}
  release = installGitHubProjectAccounts({
    getRepos: () => {
      onRead()
      return store.getRepos()
    }
  })
  remote.mockReset().mockResolvedValue(repository)
  request = (args, child) =>
    queueMicrotask(() => complete(child, args.includes('POST') ? '{}' : checkResponse()))
  spawnMock
    .mockReset()
    .mockImplementation((_command, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const child = createFakeSpawnedChild()
      if (args[0] === 'auth') {
        queueMicrotask(() =>
          complete(
            child,
            args.includes('--help') ? '--user' : `${args[args.indexOf('--user') + 1]}-token`
          )
        )
      } else {
        requests.push({ args, token: options.env.GH_TOKEN })
        request(args, child, options.env.GH_TOKEN)
      }
      return child
    })
})
afterEach(async () => {
  release()
  _resetGhRateLimitBreaker()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('separates unresolved callers by saved account before coalescing and returns each account result', async () => {
  let finish: () => void = () => {}
  let started: () => void = () => {}
  const dispatched = new Promise<void>((resolve) => {
    started = resolve
  })
  request = (_args, child, token) => {
    if (token === 'Alice-token') {
      finish = () => complete(child, checkResponse('Alice CI'))
      started()
    } else {
      queueMicrotask(() => complete(child, checkResponse('Bob CI')))
    }
  }
  const first = getPRChecks('/work', 42, undefined, repository)
  await dispatched
  rebind()
  const second = getPRChecks('/work', 42, undefined, repository)
  // Bob must settle independently while Alice's child is still pending.
  await expect(second).resolves.toMatchObject([{ name: 'Bob CI', workflowRunId: 99 }])
  finish()
  await expect(first).resolves.toMatchObject([{ name: 'Alice CI', workflowRunId: 99 }])
  expect(requests.map((r) => r.token)).toEqual(['Alice-token', 'Bob-token'])
})

it('settles the full rerun read/write on the initial account and uses the rebind on the next operation', async () => {
  rebindDuringFirstResolution()
  await expect(
    rerunPRChecks('/work', 42, { prRepo: repository, failedOnly: true }, null, { ghAccount: bob })
  ).resolves.toEqual({ ok: true, count: 1 })
  expect(requests.map((r) => ({ post: r.args.includes('POST'), token: r.token }))).toEqual([
    { post: false, token: 'Alice-token' },
    { post: true, token: 'Alice-token' }
  ])
  await expect(
    rerunPRChecks('/work', 42, { prRepo: repository, failedOnly: true })
  ).resolves.toEqual({ ok: true, count: 1 })
  expect(requests.slice(2).map((r) => r.token)).toEqual(['Bob-token', 'Bob-token'])
})

it('loads both file versions under one saved selection across repository resolution and future rebind', async () => {
  rebindDuringFirstResolution()
  request = (args, child, token) =>
    queueMicrotask(() =>
      complete(child, `${token}:${args.some((arg) => arg.includes('ref=base')) ? 'base' : 'head'}`)
    )
  const input = {
    repoPath: '/work',
    prRepo: repository,
    prNumber: 42,
    path: 'src/a.ts',
    status: 'modified',
    headSha: 'head',
    baseSha: 'base'
  } as const
  await expect(getPRFileContents(input)).resolves.toMatchObject({
    original: 'Alice-token:base',
    modified: 'Alice-token:head',
    originalIsBinary: false,
    modifiedIsBinary: false
  })
  await expect(getPRFileContents(input)).resolves.toMatchObject({
    original: 'Bob-token:base',
    modified: 'Bob-token:head'
  })
})

it('carries reloaded selection through runtime work-item details/list/count and returns fresh unbound results', async () => {
  request = (args, child, token) => {
    const title = token ?? 'ambient'
    let output: unknown
    if (args.includes('.total_count')) {
      output = token === 'Alice-token' ? 7 : 13
    } else if (args[0] === 'pr') {
      output = [pr(title)]
    } else if (args.some((arg) => arg.includes('search/issues'))) {
      output = [issue(title)]
    } else if (args.includes('graphql')) {
      output = {
        data: {
          repository: {
            issue: { body: title, comments: { nodes: [] }, participants: { nodes: [] } }
          }
        }
      }
    } else if (args.some((arg) => arg.includes('/timeline'))) {
      output = []
    } else {
      output = issue(title)
    }
    queueMicrotask(() => complete(child, JSON.stringify(output)))
  }
  const runtime = new RuntimeGitHubRepositoryQueryCommands({
    resolveRepo: async () => {
      const repo = store.getRepo('work')
      if (!repo) {
        throw new Error('missing fixture')
      }
      return repo
    },
    getLocalGitArgs: () => []
  })
  let finish: () => void = () => {}
  let started: () => void = () => {}
  const resolving = new Promise<void>((resolve) => {
    started = resolve
  })
  remote.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(repository)
        started()
      })
  )
  const pending = runtime.getRepoWorkItemDetails('work', 42, 'issue')
  await resolving
  rebind()
  finish()
  await expect(pending).resolves.toMatchObject({
    item: { title: 'Alice-token' },
    body: 'Alice-token'
  })
  await expect(runtime.getRepoWorkItem('work', 42, 'issue')).resolves.toMatchObject({
    title: 'Bob-token'
  })
  store.updateRepo({ id: 'work' }, { ghAccount: alice })
  rebindDuringFirstResolution()
  await expect(runtime.listRepoWorkItems('work')).resolves.toMatchObject({
    items: [{ title: 'Alice-token' }, { title: 'Alice-token' }]
  })
  store.updateRepo({ id: 'work' }, { ghAccount: alice })
  rebindDuringFirstResolution()
  await expect(runtime.countRepoWorkItems('work')).resolves.toBe(7)
  await expect(runtime.countRepoWorkItems('work')).resolves.toBe(13)
  expect(requests.at(-1)?.token).toBe('Bob-token')
  store.updateRepo({ id: 'work' }, { ghAccount: null })
  await expect(runtime.getRepoWorkItem('work', 42, 'issue')).resolves.toMatchObject({
    title: expect.not.stringMatching(/Alice|Bob/)
  })
})

it('returns the branch review and worktree start point from account-free refresh inputs', async () => {
  request = (args, child, token) => {
    const output =
      args[0] === 'pr'
        ? args[1] === 'list'
          ? [pr(token ?? 'ambient')]
          : pr(token ?? 'ambient')
        : args.some((arg) => arg.includes('/pulls?'))
          ? [
              {
                number: 42,
                title: token,
                state: 'open',
                html_url: 'https://github.com/acme/widgets/pull/42',
                head: { ref: 'feature', repo: { name: 'widgets', owner: { login: 'acme' } } },
                base: { ref: 'main' }
              }
            ]
          : args.includes('graphql')
            ? { data: { repository: {} } }
            : args.some((arg) => arg.includes('/stacks'))
              ? []
              : pr(token ?? 'ambient')
    queueMicrotask(() =>
      complete(
        child,
        `${args.includes('--include') ? 'HTTP/2.0 200 OK\r\n\r\n' : ''}${JSON.stringify(output)}`
      )
    )
  }
  const [refresh] = hostedReviewOptionArgs({ localGitOptions: { ghAccount: alice } })
  expect(refresh?.localGitExecOptions?.ghAccount).toBeUndefined()
  const outcome = await getPRForBranchOutcome('/work', 'feature', null, null, null, refresh)
  expect(outcome).toMatchObject({ kind: 'found', pr: { title: 'Alice-token', number: 42 } })
  const fetched: string[] = []
  await expect(
    resolveGitHubPrStartPoint({
      repoPath: '/work',
      prNumber: 42,
      gitExec: async () => ({ stdout: 'head-sha', stderr: '' }),
      resolveRemote: async () => 'origin',
      fetchRemoteTrackingRef: async (remoteName, branch) => {
        fetched.push(`${remoteName}/${branch}`)
      },
      fetchPullRequestHeadRef: async () => 'refs/pull/42/head'
    })
  ).resolves.toMatchObject({ baseBranch: 'head-sha', headSha: 'head-sha' })
  expect(fetched).toContain('origin/feature')
  expect(requests.every((r) => r.token === 'Alice-token')).toBe(true)
})

it('settles stack prepare/create/register with one saved selection after a pending rebind', async () => {
  let finish: () => void = () => {}
  let started: () => void = () => {}
  const resolving = new Promise<void>((resolve) => {
    started = resolve
  })
  remote.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(repository)
        started()
      })
  )
  request = (args, child) => {
    let output: unknown = []
    if (args[0] === 'pr' && args[1] === 'create') {
      output = { number: 43, url: 'https://github.com/acme/widgets/pull/43' }
    } else if (args.some((arg) => arg.includes('pulls?') && arg.includes('%3Aparent'))) {
      output = [
        {
          number: 42,
          html_url: 'https://github.com/acme/widgets/pull/42',
          head: { ref: 'parent' },
          base: { ref: 'main' }
        }
      ]
    } else if (args.includes('POST')) {
      output = { number: 50 }
    }
    queueMicrotask(() => complete(child, JSON.stringify(output)))
  }
  const pending = createStackedHostedReview(
    '/work',
    { provider: 'github', base: 'parent', head: 'feature', title: 'Change' },
    'local'
  )
  await resolving
  rebind()
  finish()
  await expect(pending).resolves.toMatchObject({
    ok: true,
    number: 43,
    stackNumber: 50,
    parentReview: { number: 42 }
  })
  expect(requests.some((r) => r.args[0] === 'pr' && r.args[1] === 'create')).toBe(true)
  expect(requests.some((r) => r.args.includes('POST'))).toBe(true)
  expect(requests.every((r) => r.token === 'Alice-token')).toBe(true)
})
