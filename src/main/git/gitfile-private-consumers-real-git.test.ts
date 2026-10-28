import { runProcess } from '@orca/process-host'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getOwnerRepoForRemote, _resetOwnerRepoCache } from '../github/github-repository-identity'
import {
  readLocalGitConfigSignature,
  __resetLocalGitConfigSignatureCacheForTests
} from '../github/local-git-config-signature'
import {
  classifyWorktreeBaseChange,
  type WorktreeBaseWatchTarget
} from '../ipc/worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription
} from '../ipc/worktree-base-directory-poller'
import { resolveWorktreeCommonGitDirectory } from '../ipc/worktree-common-git-directory'
import { startGitCommonPrimaryPolling } from '../ipc/worktree-git-common-primary-polling'

let root = ''
const subscriptions: WorktreeBaseSubscription[] = []
const names =
  process.platform === 'win32' ? ['ordinary'] : ['ordinary', 'line\nbreak', 'slash\\name']

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-private-gitfile-')))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'missing-config'))
  _resetOwnerRepoCache()
  __resetLocalGitConfigSignatureCacheForTests()
})

afterEach(async () => {
  await Promise.all(subscriptions.splice(0).map((subscription) => subscription.unsubscribe()))
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args,
    cwd,
    env: process.env,
    timeoutMs: 10_000
  })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

async function createLinkedRepo(name: string): Promise<{ repo: Repo; decoy: string | null }> {
  const main = join(root, name)
  const linked = join(root, 'linked')
  await mkdir(main)
  await git(main, 'init', '-q')
  await git(
    main,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    '-c',
    'core.hooksPath=',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'base'
  )
  await git(main, 'remote', 'add', 'origin', 'https://github.com/old-owner/old-repo.git')
  await git(main, 'worktree', 'add', '-qb', 'linked', linked)
  let decoy: string | null = null
  if (name.includes('\n')) {
    decoy = join(root, 'line')
    await git(root, 'init', '--bare', '-q', decoy)
  } else if (name.includes('\\')) {
    decoy = join(root, 'slash', 'name')
    await mkdir(decoy, { recursive: true })
    await git(decoy, 'init', '-q')
  }
  return {
    repo: { id: 'selected', path: linked, displayName: 'Selected', badgeColor: '', addedAt: 0 },
    decoy
  }
}

it.each(names)('revalidates the public cached identity after %j config changes', async (name) => {
  const { repo, decoy } = await createLinkedRepo(name)
  expect(await getOwnerRepoForRemote(repo.path, 'origin')).toEqual({
    owner: 'old-owner',
    repo: 'old-repo'
  })
  if (decoy) {
    const before = await readLocalGitConfigSignature({ repoPath: repo.path })
    await git(decoy, 'config', 'audit.decoy', 'changed')
    expect(await readLocalGitConfigSignature({ repoPath: repo.path })).toBe(before)
  }
  await git(
    repo.path,
    'remote',
    'set-url',
    'origin',
    'https://github.com/new-owner/changed-repo.git'
  )
  expect(await getOwnerRepoForRemote(repo.path, 'origin')).toEqual({
    owner: 'new-owner',
    repo: 'changed-repo'
  })
})

it('rejects invalid marker prefixes instead of signing or watching their candidate', async () => {
  const { repo } = await createLinkedRepo('ordinary')
  const markerPath = join(repo.path, '.git')
  const marker = await readFile(markerPath, 'utf8')
  for (const invalid of [
    marker.replace('gitdir: ', 'gitdir:'),
    marker.replace('gitdir:', 'GITDIR:'),
    `ignored\n${marker}`
  ]) {
    await writeFile(markerPath, invalid)
    expect(
      (
        await runProcess({
          program: 'git',
          args: ['rev-parse', '--git-dir'],
          cwd: repo.path,
          timeoutMs: 10_000
        })
      ).code
    ).not.toBe(0)
    expect(await readLocalGitConfigSignature({ repoPath: repo.path })).toBeUndefined()
    expect(await resolveWorktreeCommonGitDirectory(repo)).toBeNull()
  }
})

it.each(names)('delivers %j metadata changes without sibling config events', async (name) => {
  const { repo, decoy } = await createLinkedRepo(name)
  const commonDir = await resolveWorktreeCommonGitDirectory(repo)
  if (!commonDir) {
    throw new Error('Linked repository has no metadata watch root')
  }
  const target: WorktreeBaseWatchTarget = {
    key: `git-common:${commonDir}`,
    kind: 'git-common',
    path: commonDir,
    repos: new Map([[repo.id, { repoId: repo.id, repoName: 'linked', nestWorkspaces: true }]])
  }
  const received: WorktreeBasePollEvent[] = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  subscriptions.push(
    await startGitCommonPrimaryPolling(
      commonDir,
      () => [],
      (events) => received.push(...events),
      100,
      {
        isWindowVisible: () => true,
        onWindowBecameVisible: () => () => {}
      }
    )
  )
  await git(repo.path, 'config', 'branch.linked.remote', 'origin')
  await vi.waitFor(() => {
    expect(received.some((event) => event.path === join(commonDir, 'config'))).toBe(true)
  })
  expect(
    received.flatMap((event) => classifyWorktreeBaseChange(target, event).gitStatusRepoIds)
  ).toContain(repo.id)

  received.length = 0
  if (decoy) {
    await git(decoy, 'config', 'audit.decoy', 'changed')
  }
  // Packed refs provide an observed snapshot after the sibling write, without changing our config.
  await git(repo.path, 'pack-refs', '--all')
  await vi.waitFor(() => {
    expect(received.some((event) => event.path === join(commonDir, 'packed-refs'))).toBe(true)
  })
  expect(
    received.flatMap((event) => classifyWorktreeBaseChange(target, event).gitStatusRepoIds)
  ).toEqual([])
})
