import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'

const { execFileMock, killTreeMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  killTreeMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original()),
  execFile: execFileMock
}))
vi.mock('../command-runner/spawned-command-tree-kill', () => ({
  killSpawnedCommandTree: killTreeMock
}))

import { getCommitDiff } from './commit-diff'
import { getBranchDiff } from './branch-diff'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import {
  acquireGitAdmission,
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from '../command-runner/git-subprocess-admission'

const commitOid = 'a'.repeat(40)
const args = { commitOid, filePath: 'file.txt' }
const blockers: { release: () => void }[] = []
const pending: Promise<unknown>[] = []

function read(index: number, signal?: AbortSignal) {
  const promise = getCommitDiff('/repo', { ...args, filePath: `file-${index}.txt` }, { signal })
  pending.push(promise)
  void promise.catch(() => {})
  return promise
}

async function blockAdmission(): Promise<void> {
  blockers.push(await acquireGitAdmission({ args: ['show', 'blocker'], cwd: '/repo' }))
}

beforeEach(() => {
  invalidateGitReadCaches()
  _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 }))
  execFileMock.mockReset()
  execFileMock.mockImplementation(
    (
      _program: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void
    ) => {
      const child = createFakeSpawnedChild()
      queueMicrotask(() => {
        callback(null, Buffer.from('live content\n'), Buffer.alloc(0))
        child.emit('close', 0, null)
      })
      return child
    }
  )
  killTreeMock.mockReset()
  killTreeMock.mockImplementation(async (child: ChildProcess) => {
    child.emit('close', null, 'SIGTERM')
  })
})

afterEach(async () => {
  for (const blocker of blockers.splice(0)) {
    blocker.release()
  }
  await Promise.allSettled(pending.splice(0))
  invalidateGitReadCaches()
  _resetGitAdmissionForTests()
})

describe('diff read cancellation at production admission', () => {
  it.each([5, 50])(
    'removes %i retired reads before spawning and admits a live successor',
    async (count) => {
      await blockAdmission()
      const controllers = Array.from({ length: count }, () => new AbortController())
      const reads = controllers.map((controller, index) => read(index, controller.signal))
      await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(count))
      for (const controller of controllers) {
        controller.abort()
      }
      expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
      for (const result of await Promise.allSettled(reads)) {
        expect(result.status).toBe('rejected')
      }
      expect(execFileMock).not.toHaveBeenCalled()
      blockers.pop()?.release()
      await expect(read(count)).resolves.toMatchObject({ modifiedContent: 'live content\n' })
      expect(execFileMock).toHaveBeenCalledOnce()
      expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
    }
  )

  it.each([false, true])(
    'preserves a same-key reader without tying work to the first caller (legacy: %s)',
    async (legacy) => {
      await blockAdmission()
      const first = new AbortController()
      const second = new AbortController()
      const one = read(0, first.signal)
      const two = read(0, legacy ? undefined : second.signal)
      await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(1))
      first.abort()
      await expect(one).rejects.toMatchObject({ name: 'AbortError' })
      expect(_gitAdmissionSnapshotForTests().queued).toBe(1)
      blockers.pop()?.release()
      await expect(two).resolves.toMatchObject({ modifiedContent: 'live content\n' })
      expect(execFileMock).toHaveBeenCalledOnce()
    }
  )

  it('keeps cancellation isolated across execution options and diff kinds', async () => {
    await blockAdmission()
    const one = new AbortController()
    const two = new AbortController()
    const three = new AbortController()
    const reads = [
      getCommitDiff('/repo', args, { signal: one.signal, wslDistro: 'Ubuntu' }),
      getCommitDiff('/repo', args, { signal: two.signal, wslDistro: 'Debian' }),
      getBranchDiff(
        '/repo',
        { headOid: commitOid, mergeBase: commitOid, filePath: args.filePath },
        { signal: three.signal }
      )
    ]
    pending.push(...reads)
    void Promise.allSettled(reads)
    await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(4))
    one.abort()
    await expect(reads[0]).rejects.toMatchObject({ name: 'AbortError' })
    expect(_gitAdmissionSnapshotForTests().queued).toBe(3)
    two.abort()
    three.abort()
    await Promise.allSettled(reads)
    expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('terminates an admitted read only after its last live lease cancels', async () => {
    const child = createFakeSpawnedChild()
    execFileMock.mockReturnValue(child)
    const first = new AbortController()
    const last = new AbortController()
    const one = read(0, first.signal)
    const two = read(0, last.signal)
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledOnce())
    first.abort()
    await expect(one).rejects.toMatchObject({ name: 'AbortError' })
    expect(killTreeMock).not.toHaveBeenCalled()
    last.abort()
    await expect(two).rejects.toMatchObject({ name: 'AbortError' })
    expect(killTreeMock).toHaveBeenCalledExactlyOnceWith(child)
    await vi.waitFor(() =>
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
    )
  })
})
