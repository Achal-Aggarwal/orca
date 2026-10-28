// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHistoryResult } from '../../../../shared/git-history-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { deferred, mountProbe, unmountProbes } from './source-control-hook-test-harness'
import { MAX_INACTIVE_GIT_HISTORY_BYTES } from './source-control/sync/git-history-cache'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/runtime/runtime-git-status-client', () => ({ getRuntimeGitHistory: mocks.read }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
vi.mock('./worktree-git-owner-target', () => ({
  requireGitOwnerTarget: (target: RuntimeClientTarget | null) => {
    if (!target) {
      throw new Error('Missing repository owner')
    }
    return target
  }
}))

import { useSourceControlGitHistory } from './source-control/sync/use-git-history'

function history(id: string): GitHistoryResult {
  return {
    items: [{ id, parentIds: [], subject: id, message: id }],
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: false,
    limit: 50
  }
}

const TARGET: RuntimeClientTarget = { kind: 'local' }
const WORKTREES = new Map(Array.from({ length: 50 }, (_, i) => [`repo-${i}`, {}]))
let latest: ReturnType<typeof useSourceControlGitHistory>
function Probe({
  id,
  path = `/${id}`,
  expanded = true
}: {
  id: string
  path?: string
  expanded?: boolean
}): null {
  latest = useSourceControlGitHistory({
    activeRepoTarget: TARGET,
    activeWorktreeId: id,
    worktreePath: path,
    compareBaseRef: 'main',
    isFolder: false,
    isBranchVisible: true,
    isGitHistoryExpanded: expanded,
    isGitHistoryVisible: true,
    worktreeMap: WORKTREES
  })
  return null
}

beforeEach(() => {
  mocks.read
    .mockReset()
    .mockImplementation(async ({ worktreeId }: { worktreeId: string }) => history(worktreeId))
})
afterEach(() => {
  unmountProbes()
  mocks.read.mockReset()
})

describe('Git history retained workspace budget', () => {
  it.each([5, 50])(
    'keeps a recent cached result while refetching after %i visits',
    async (count) => {
      const root = await mountProbe(<Probe id="repo-0" />)
      for (let i = 1; i < count; i++) {
        await act(async () => root.render(<Probe id={`repo-${i}`} />))
      }
      const refreshing = deferred<GitHistoryResult>()
      mocks.read.mockReturnValueOnce(refreshing.promise)
      await act(async () => root.render(<Probe id={`repo-${count - 2}`} />))
      expect(latest.gitHistoryState).toEqual({
        status: 'refreshing',
        result: history(`repo-${count - 2}`)
      })
      expect(mocks.read).toHaveBeenCalledTimes(count + 1)
      await act(async () => refreshing.resolve(history('updated')))
      expect(latest.gitHistoryState).toEqual({ status: 'ready', result: history('updated') })

      if (count > 5) {
        mocks.read.mockReturnValueOnce(deferred<GitHistoryResult>().promise)
        await act(async () => root.render(<Probe id="repo-0" />))
        expect(latest.gitHistoryState).toEqual({ status: 'loading' })
      }
    }
  )

  it('preserves an oversized active result and releases it once inactive', async () => {
    const oversized = history('oversized')
    oversized.items[0].message = 'm'.repeat(MAX_INACTIVE_GIT_HISTORY_BYTES)
    mocks.read.mockResolvedValueOnce(oversized)
    const root = await mountProbe(<Probe id="repo-0" />)
    expect(latest.gitHistoryState).toEqual({ status: 'ready', result: oversized })

    await act(async () => root.render(<Probe id="repo-1" />))
    mocks.read.mockReturnValueOnce(deferred<GitHistoryResult>().promise)
    await act(async () => root.render(<Probe id="repo-0" />))
    expect(latest.gitHistoryState).toEqual({ status: 'loading' })
  })

  it('keeps other recent pages when an oversized active page becomes inactive', async () => {
    const root = await mountProbe(<Probe id="repo-0" />)
    const oversized = history('oversized')
    oversized.items[0].message = 'm'.repeat(MAX_INACTIVE_GIT_HISTORY_BYTES)
    mocks.read.mockResolvedValueOnce(oversized)
    await act(async () => root.render(<Probe id="repo-1" />))
    expect(latest.gitHistoryState).toEqual({ status: 'ready', result: oversized })
    await act(async () => root.render(<Probe id="repo-2" />))
    mocks.read.mockReturnValueOnce(deferred<GitHistoryResult>().promise)
    await act(async () => root.render(<Probe id="repo-0" />))
    expect(latest.gitHistoryState).toEqual({ status: 'refreshing', result: history('repo-0') })
  })

  it('charges authors and nested ref metadata even when messages are small', async () => {
    mocks.read.mockImplementation(async ({ worktreeId }: { worktreeId: string }) => {
      const result = history(worktreeId)
      result.items[0].author = 'a'.repeat(MAX_INACTIVE_GIT_HISTORY_BYTES / 8)
      result.items[0].references = [
        {
          id: 'refs/tags/large',
          name: 'large',
          description: 'r'.repeat(MAX_INACTIVE_GIT_HISTORY_BYTES / 8)
        }
      ]
      result.remoteRef = {
        id: 'refs/remotes/origin/main',
        name: 'main',
        description: 'd'.repeat(MAX_INACTIVE_GIT_HISTORY_BYTES / 8)
      }
      return result
    })
    const root = await mountProbe(<Probe id="repo-0" />)
    for (let i = 1; i < 4; i++) {
      await act(async () => root.render(<Probe id={`repo-${i}`} />))
    }
    mocks.read.mockReturnValueOnce(deferred<GitHistoryResult>().promise)
    await act(async () => root.render(<Probe id="repo-0" />))
    expect(latest.gitHistoryState).toEqual({ status: 'loading' })
  })

  it.each(['success', 'failure'] as const)(
    'does not restore an evicted pending %s',
    async (outcome) => {
      const old = deferred<GitHistoryResult>()
      mocks.read.mockReturnValueOnce(old.promise)
      const root = await mountProbe(<Probe id="repo-0" />)
      for (let i = 1; i < 8; i++) {
        await act(async () => root.render(<Probe id={`repo-${i}`} />))
      }
      await act(async () => {
        if (outcome === 'success') {
          old.resolve(history('retired'))
        } else {
          old.reject(new Error('Retired repository disconnected'))
        }
      })
      await act(async () => root.render(<Probe id="repo-0" expanded={false} />))
      expect(latest.gitHistoryState).toEqual({ status: 'idle' })
      expect(mocks.read).toHaveBeenCalledTimes(8)
      mocks.read.mockReturnValueOnce(deferred<GitHistoryResult>().promise)
      await act(async () => root.render(<Probe id="repo-0" />))
      expect(latest.gitHistoryState).toEqual({ status: 'loading' })
    }
  )

  it('retires a prior repository view while collapsed without starting a new read', async () => {
    const old = deferred<GitHistoryResult>()
    mocks.read.mockReturnValueOnce(old.promise)
    const root = await mountProbe(<Probe id="repo-0" />)
    await act(async () => root.render(<Probe id="repo-0" path="/replacement" expanded={false} />))
    await act(async () => old.resolve(history('retired')))

    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(latest.gitHistoryState).toEqual({ status: 'idle' })
  })
})
