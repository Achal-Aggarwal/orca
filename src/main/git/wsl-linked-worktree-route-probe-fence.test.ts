import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateWslLinkedWorktreeGitRouting,
  prepareWslLinkedWorktreeGitRouting,
  resetWslLinkedWorktreeGitRoutingForTests,
  usesHostGitForWslLinkedWorktree,
  type WslLinkedWorktreeRoutingFileSystem
} from './wsl-linked-worktree-git-routing'

const CWD = String.raw`C:\repo\linked`
const hostGitdir = 'gitdir: C:/main/.git/worktrees/linked\n'
const distroGitdir = 'gitdir: /home/dev/main/.git/worktrees/linked\n'
const fileMarker = { isDirectory: () => false, isFile: () => true }

afterEach(() => resetWslLinkedWorktreeGitRoutingForTests())

function markerFileSystem(readFile: () => Promise<string>): WslLinkedWorktreeRoutingFileSystem {
  return { stat: async () => fileMarker, readFile }
}

function prepare(
  fileSystem: WslLinkedWorktreeRoutingFileSystem,
  cwd = CWD,
  distro = 'Ubuntu'
): Promise<boolean> {
  return prepareWslLinkedWorktreeGitRouting(cwd, distro, {
    platform: 'win32',
    fileSystem,
    now: () => 1_000
  })
}

describe('linked-worktree route probe ownership', () => {
  it.each([CWD, 'C:/repo/linked/', String.raw`C:\repo`])(
    'retires a pending marker read when invalidating %s',
    async (invalidatedPath) => {
      const marker = Promise.withResolvers<string>()
      const started = Promise.withResolvers<void>()
      const oldFileSystem = markerFileSystem(() => {
        started.resolve()
        return marker.promise
      })
      const oldRoute = prepare(oldFileSystem)
      await started.promise

      invalidateWslLinkedWorktreeGitRouting(invalidatedPath)
      marker.resolve(hostGitdir)
      await expect(oldRoute).resolves.toBe(false)
      expect(usesHostGitForWslLinkedWorktree(CWD, 'Ubuntu', 'win32', () => 1_000)).toBe(false)

      const freshRead = vi.fn(async () => distroGitdir)
      await expect(prepare(markerFileSystem(freshRead))).resolves.toBe(false)
      expect(freshRead).toHaveBeenCalledOnce()
    }
  )

  it('starts fresh discovery before the retired read finishes and preserves its answer', async () => {
    const marker = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    const oldRoute = prepare(
      markerFileSystem(() => {
        started.resolve()
        return marker.promise
      })
    )
    await started.promise
    invalidateWslLinkedWorktreeGitRouting(CWD)

    const freshRead = vi.fn(async () => distroGitdir)
    const freshRoute = prepare(markerFileSystem(freshRead))
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(freshRead).toHaveBeenCalledOnce()
      await expect(freshRoute).resolves.toBe(false)
    } finally {
      marker.resolve(hostGitdir)
      await oldRoute
      await freshRoute
    }

    const unexpectedRead = vi.fn(async () => hostGitdir)
    await expect(prepare(markerFileSystem(unexpectedRead))).resolves.toBe(false)
    expect(unexpectedRead).not.toHaveBeenCalled()
    expect(usesHostGitForWslLinkedWorktree(CWD, 'Ubuntu', 'win32', () => 1_000)).toBe(false)
  })

  it('keeps the successor joinable when an older marker read finishes first', async () => {
    const oldMarker = Promise.withResolvers<string>()
    const freshMarker = Promise.withResolvers<string>()
    const oldStarted = Promise.withResolvers<void>()
    const oldRoute = prepare(
      markerFileSystem(() => {
        oldStarted.resolve()
        return oldMarker.promise
      })
    )
    await oldStarted.promise
    invalidateWslLinkedWorktreeGitRouting(CWD)

    const freshRead = vi.fn(() => freshMarker.promise)
    const freshFileSystem = markerFileSystem(freshRead)
    const freshRoute = prepare(freshFileSystem)
    oldMarker.resolve(hostGitdir)
    const oldResult = await oldRoute
    const joined = prepare(freshFileSystem)
    freshMarker.resolve(distroGitdir)

    await expect(Promise.all([freshRoute, joined])).resolves.toEqual([false, false])
    expect(oldResult).toBe(false)
    expect(freshRead).toHaveBeenCalledOnce()
  })

  it('does not restore retry backoff from retired read failures', async () => {
    const marker = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    const oldRoute = prepare(
      markerFileSystem(() => {
        started.resolve()
        return marker.promise
      })
    )
    await started.promise
    invalidateWslLinkedWorktreeGitRouting(CWD)

    const freshRead = vi.fn(async () => '')
    const freshRoute = prepare(markerFileSystem(freshRead))
    await new Promise<void>((resolve) => setImmediate(resolve))
    marker.reject(Object.assign(new Error('old device unavailable'), { code: 'EIO' }))
    await Promise.all([oldRoute, freshRoute])

    const retryRead = vi.fn(async () => hostGitdir)
    await expect(prepare(markerFileSystem(retryRead))).resolves.toBe(true)
    expect(freshRead).toHaveBeenCalledOnce()
    expect(retryRead).toHaveBeenCalledOnce()
  })

  it('preserves pending sibling and case-distinct paths across distro waiters', async () => {
    const marker = Promise.withResolvers<string>()
    const readFile = vi.fn(() => marker.promise)
    const fileSystem = markerFileSystem(readFile)
    const sibling = String.raw`C:\repo\linked-other`
    const caseDistinct = String.raw`C:\repo\Linked`
    const siblingRoute = prepare(fileSystem, sibling)
    const caseRoute = prepare(fileSystem, caseDistinct)
    await new Promise<void>((resolve) => setImmediate(resolve))

    invalidateWslLinkedWorktreeGitRouting(CWD)
    const siblingJoiner = prepare(fileSystem, sibling, 'Debian')
    const caseJoiner = prepare(fileSystem, caseDistinct, 'Debian')
    marker.resolve(hostGitdir)

    await expect(
      Promise.all([siblingRoute, caseRoute, siblingJoiner, caseJoiner])
    ).resolves.toEqual([true, true, true, true])
    expect(readFile).toHaveBeenCalledTimes(2)
  })
})
