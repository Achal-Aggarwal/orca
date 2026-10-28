import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { resolveRuntimeLocalWorktreeCreateBase } from '../runtime/runtime-local-worktree-create-base'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import { prefetchWorktreeCreateBase } from '../worktree-create-base-prefetch'
import { createWorktreeCreateTimingRecorder } from '../worktree-create-timing'
import { hasLocalWorktreeBaseRef } from './worktree-base-ref-probe'

const directories: string[] = []
let supportsSha256 = false

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

async function createRepo(format: 'sha1' | 'sha256') {
  const directory = await mkdtemp(join(tmpdir(), 'orca-worktree-object-format-'))
  directories.push(directory)
  await git(directory, 'init', '-q', ...(format === 'sha256' ? ['--object-format=sha256'] : []))
  await git(directory, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(directory, 'config', 'user.name', 'Audit')
  await git(directory, 'config', 'user.email', 'audit@example.test')
  await git(directory, 'config', 'commit.gpgsign', 'false')
  await git(directory, 'config', 'core.hooksPath', '')
  await git(directory, 'commit', '--allow-empty', '-qm', 'base')
  const oid = await git(directory, 'rev-parse', 'HEAD')
  expect(oid).toHaveLength(format === 'sha256' ? 64 : 40)
  return { directory, oid }
}

beforeAll(async () => {
  const result = await runProcess({ program: 'git', args: ['--version'] })
  expect(result.code).toBe(0)
  const match = result.stdout.match(/git version (\d+)\.(\d+)/)
  expect(match).not.toBeNull()
  const major = Number(match?.[1])
  const minor = Number(match?.[2])
  supportsSha256 = major > 2 || (major === 2 && minor >= 29)
})

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe.each(['sha1', 'sha256'] as const)('%s local worktree bases', (format) => {
  it('recognizes a local object before scheduling an origin refresh', async (context) => {
    if (format === 'sha256' && !supportsSha256) {
      context.skip()
    }
    const { directory, oid } = await createRepo(format)
    const base = await resolveRuntimeLocalWorktreeCreateBase({
      repoPath: directory,
      baseBranch: oid,
      localWorktreeGitOptions: {},
      allowLocalBaseFallback: false,
      resolveRemoteTrackingBase: async () => null,
      hasRemoteTrackingRef: async () => false,
      refreshRemoteTrackingBase: async () => ({ ok: false, errorKind: 'git_error' }),
      timing: createWorktreeCreateTimingRecorder()
    })

    expect(base).toEqual({ baseBranch: oid, remoteTrackingBase: null, deferredRefresh: null })
  })

  it('prefetches an existing object without fetching origin', async (context) => {
    if (format === 'sha256' && !supportsSha256) {
      context.skip()
    }
    const { directory, oid } = await createRepo(format)
    const fetchRemoteWithCache = vi.fn(async () => {})
    const prepareCheckout = vi.fn(async () => {})

    expect(
      await prefetchWorktreeCreateBase({
        repo: { id: 'repo', path: directory, displayName: 'repo', badgeColor: '', addedAt: 0 },
        baseBranch: oid,
        gitOptions: {},
        prepareCheckout,
        runtime: {
          resolveRemoteTrackingBase: async () => null,
          hasRemoteTrackingRef: async () => false,
          getOrStartRemoteTrackingBaseRefresh: async () => ({ ok: false }),
          fetchRemoteWithCache
        }
      })
    ).toBe(oid)
    expect(fetchRemoteWithCache).not.toHaveBeenCalled()
    expect(prepareCheckout).toHaveBeenCalledWith(oid, undefined)
  })

  it('keeps a persisted local object instead of falling back to the default branch', async (context) => {
    if (format === 'sha256' && !supportsSha256) {
      context.skip()
    }
    const { directory, oid } = await createRepo(format)
    await git(directory, 'commit', '--allow-empty', '-qm', 'newer default')
    expect(await git(directory, 'rev-parse', 'HEAD')).not.toBe(oid)

    expect(
      await resolveWorktreeCreateBase({
        repoWorktreeBaseRef: oid,
        resolveDefaultBaseRef: async () => 'refs/heads/main',
        isBaseUsable: (candidate) => hasLocalWorktreeBaseRef(directory, candidate)
      })
    ).toBe(oid)
  })
})

installRealWorkerThreadChildProcesses()
