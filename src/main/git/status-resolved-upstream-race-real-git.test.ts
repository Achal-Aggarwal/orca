import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitExecOptions } from './command-runner/git-exec-options'
import type * as GitRunner from './runner'

const delivery = vi.hoisted(() => {
  const state: {
    hold?: (args: string[]) => Promise<void>
    calls: string[][]
  } = { calls: [] }
  return state
})

vi.mock('./runner', async (importOriginal) => {
  const original = await importOriginal<typeof GitRunner>()
  return {
    ...original,
    gitExecFileAsync: async (args: string[], options: GitExecOptions) => {
      try {
        return await original.gitExecFileAsync(args, options)
      } finally {
        delivery.calls.push(args)
        await delivery.hold?.(args)
      }
    }
  }
})

import { clearEffectiveUpstreamStatusCacheForTests, getStatus } from './status'
import { invalidateGitReadCaches } from './source-control/git-read-cache-invalidation'
import { clearEffectiveUpstreamNegativeStatusCache } from './source-control/effective-upstream-status-cache'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

const directories: string[] = []

function barrier() {
  let release = (): void => {}
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return { ready, release }
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

async function createRepo() {
  clearEffectiveUpstreamStatusCacheForTests()
  delivery.calls = []
  const directory = await mkdtemp(join(tmpdir(), 'orca-resolved-upstream-'))
  directories.push(directory)
  await git(directory, 'init', '-q')
  await git(directory, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(directory, 'config', 'user.name', 'Audit')
  await git(directory, 'config', 'user.email', 'audit@example.test')
  await git(directory, 'config', 'commit.gpgsign', 'false')
  await git(directory, 'config', 'core.hooksPath', '')
  await git(directory, 'commit', '--allow-empty', '-qm', 'base')
  await git(directory, 'remote', 'add', 'origin', './unused')
  await git(directory, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(directory, 'checkout', '-qb', 'feature')
  await git(directory, 'config', 'branch.feature.remote', 'origin')
  await git(directory, 'config', 'branch.feature.merge', 'refs/heads/main')
  await git(directory, 'commit', '--allow-empty', '-qm', 'feature')
  return directory
}

afterEach(async () => {
  delivery.hold = undefined
  clearEffectiveUpstreamStatusCacheForTests()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('resolved upstream publication with real Git', () => {
  it.each([
    { refresh: 'global', oldFirst: false },
    { refresh: 'branch', oldFirst: false },
    { refresh: 'strict', oldFirst: false },
    { refresh: 'global', oldFirst: true },
    { refresh: 'branch', oldFirst: true },
    { refresh: 'strict', oldFirst: true }
  ])(
    'keeps the fresh published branch ($refresh refresh, oldFirst=$oldFirst)',
    async ({ refresh, oldFirst }) => {
      const directory = await createRepo()
      const captured = barrier()
      const resume = barrier()
      const freshCaptured = barrier()
      const resumeFresh = barrier()
      delivery.hold = async (args) => {
        if (args[0] === 'rev-list' && args.includes('HEAD...origin/main')) {
          captured.release()
          await resume.ready
        } else if (args[0] === 'rev-list' && args.includes('HEAD...origin/feature')) {
          freshCaptured.release()
          await resumeFresh.ready
        }
      }
      const older = getStatus(directory, { includeLineStats: false })
      await captured.ready
      try {
        await git(directory, 'update-ref', 'refs/remotes/origin/feature', 'HEAD')
        if (refresh === 'global') {
          invalidateGitReadCaches()
        } else if (refresh === 'branch') {
          clearEffectiveUpstreamNegativeStatusCache({
            worktreePath: directory,
            branchName: 'feature',
            upstreamName: 'origin/main'
          })
        }
        const freshRequest = getStatus(directory, {
          includeLineStats: false,
          bypassEffectiveUpstreamNegativeCache: true
        })
        await freshCaptured.ready
        if (oldFirst) {
          resume.release()
          await older
        }
        resumeFresh.release()
        const fresh = await freshRequest
        expect(fresh.upstreamStatus).toEqual({
          hasUpstream: true,
          upstreamName: 'origin/feature',
          ahead: 0,
          behind: 0
        })
        resume.release()
        expect((await older).upstreamStatus?.upstreamName).toBe('origin/main')
        const next = await getStatus(directory, { includeLineStats: false })
        expect(next.upstreamStatus).toEqual(fresh.upstreamStatus)
        expect(await git(directory, 'rev-parse', '--abbrev-ref', 'HEAD@{u}')).toBe('origin/main')
      } finally {
        resume.release()
        resumeFresh.release()
        await older
      }
    }
  )

  it.each(['global', 'branch'])(
    'does not repopulate an invalidated name before the next poll (%s invalidation)',
    async (invalidation) => {
      const directory = await createRepo()
      const captured = barrier()
      const resume = barrier()
      delivery.hold = async (args) => {
        if (args[0] === 'rev-list' && args.includes('HEAD...origin/main')) {
          captured.release()
          await resume.ready
        }
      }
      const older = getStatus(directory, { includeLineStats: false })
      await captured.ready
      try {
        await git(directory, 'update-ref', 'refs/remotes/origin/feature', 'HEAD')
        if (invalidation === 'global') {
          invalidateGitReadCaches()
        } else {
          clearEffectiveUpstreamNegativeStatusCache({
            worktreePath: directory,
            branchName: 'feature',
            upstreamName: 'origin/main'
          })
        }
        resume.release()
        expect((await older).upstreamStatus?.upstreamName).toBe('origin/main')
        const next = await getStatus(directory, { includeLineStats: false })
        expect(next.upstreamStatus).toEqual({
          hasUpstream: true,
          upstreamName: 'origin/feature',
          ahead: 0,
          behind: 0
        })
      } finally {
        resume.release()
        await older
      }
    }
  )

  it('keeps a newly resolved warm name when an older cached-ref read fails', async () => {
    const directory = await createRepo()
    await getStatus(directory, { includeLineStats: false })
    await git(directory, 'update-ref', '-d', 'refs/remotes/origin/main')
    const captured = barrier()
    const resume = barrier()
    delivery.hold = async (args) => {
      if (args[0] === 'rev-list' && args.includes('HEAD...origin/main')) {
        captured.release()
        await resume.ready
      }
    }
    const older = getStatus(directory, { includeLineStats: false })
    await captured.ready
    try {
      await git(directory, 'update-ref', 'refs/remotes/origin/feature', 'HEAD')
      const fresh = await getStatus(directory, {
        includeLineStats: false,
        bypassEffectiveUpstreamNegativeCache: true
      })
      expect(fresh.upstreamStatus?.upstreamName).toBe('origin/feature')
      resume.release()
      await older
      delivery.calls = []
      const next = await getStatus(directory, { includeLineStats: false })
      expect(next.upstreamStatus).toEqual(fresh.upstreamStatus)
      expect(delivery.calls.filter((args) => args[0] === 'symbolic-ref')).toHaveLength(0)
      expect(delivery.calls.filter((args) => args[0] === 'rev-list')).toHaveLength(1)
    } finally {
      resume.release()
      await older
    }
  })

  it('reuses the warm name while revalidating changed ahead counts', async () => {
    const directory = await createRepo()
    const first = await getStatus(directory, { includeLineStats: false })
    expect(first.upstreamStatus).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 1,
      behind: 0
    })
    await git(directory, 'commit', '--allow-empty', '-qm', 'second feature')
    delivery.calls = []
    const next = await getStatus(directory, { includeLineStats: false })
    expect(next.upstreamStatus).toEqual({ ...first.upstreamStatus, ahead: 2 })
    expect(delivery.calls.filter((args) => args[0] === 'symbolic-ref')).toHaveLength(0)
    expect(delivery.calls.filter((args) => args[0] === 'rev-list')).toHaveLength(1)
  })
})

installRealWorkerThreadChildProcesses()
