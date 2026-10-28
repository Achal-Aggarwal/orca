import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getRuntimeGitBranchDiff,
  getRuntimeGitCommitDiff,
  getRuntimeGitDiff
} from './runtime-git-diff-client'

const local = { target: { kind: 'local' as const }, worktreeId: 'wt', worktreePath: '/repo' }
const readers = [
  (signal: AbortSignal) =>
    getRuntimeGitDiff(local, { filePath: 'file.txt', staged: false }, signal),
  (signal: AbortSignal) =>
    getRuntimeGitCommitDiff(local, { commitOid: 'a'.repeat(40), filePath: 'file.txt' }, signal),
  (signal: AbortSignal) =>
    getRuntimeGitBranchDiff(
      local,
      {
        compare: {
          baseRef: 'main',
          baseOid: 'a'.repeat(40),
          headOid: 'b'.repeat(40),
          mergeBase: 'a'.repeat(40)
        },
        filePath: 'file.txt'
      },
      signal
    )
]

afterEach(() => vi.unstubAllGlobals())

describe('local diff caller cancellation', () => {
  it.each(readers)(
    'rejects the caller and cancels its issued token before a late host reply',
    async (read) => {
      let resolve!: (value: unknown) => void
      const load = vi.fn(
        (_args: { requestToken?: string }) =>
          new Promise((done) => {
            resolve = done
          })
      )
      const cancelDiff = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('window', {
        api: { git: { diff: load, commitDiff: load, branchDiff: load, cancelDiff } }
      })
      const controller = new AbortController()
      const result = read(controller.signal)
      const request = load.mock.calls[0]?.[0]
      controller.abort()
      await expect(result).rejects.toMatchObject({ name: 'AbortError' })
      expect(cancelDiff).toHaveBeenCalledWith({ requestToken: request.requestToken })
      resolve({ kind: 'text', originalContent: '', modifiedContent: 'obsolete' })
    }
  )

  it('retires a caller even when an older preload cannot cancel the host request', async () => {
    const load = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('window', { api: { git: { diff: load } } })
    const controller = new AbortController()
    const result = getRuntimeGitDiff(
      local,
      { filePath: 'file.txt', staged: false },
      controller.signal
    )
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(load).toHaveBeenCalledOnce()
  })

  it('does not issue a request for an already retired caller', async () => {
    const load = vi.fn()
    vi.stubGlobal('window', { api: { git: { diff: load } } })
    const controller = new AbortController()
    controller.abort()
    await expect(
      getRuntimeGitDiff(local, { filePath: 'file.txt', staged: false }, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(load).not.toHaveBeenCalled()
  })
})
