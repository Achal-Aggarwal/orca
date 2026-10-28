import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { harness, snapshots } from '../../workspace-review-subscription.test-fixture'
import type { OrcaRuntimeService } from '../../orca-runtime'

const { mocks, modules } = await vi.hoisted(async () => {
  const modules = await import('../../../github/pr-refresh-coordinator-test-mocks')
  return { mocks: modules.createPRRefreshCoordinatorMocks(), modules }
})
vi.mock('../../runtime-desktop-surface', () => modules.runtimeDesktopSurfaceModuleMock(mocks))
vi.mock('../../../github/client', () => modules.clientModuleMock(mocks))
vi.mock('../../../github/github-api-repository', () => modules.githubApiRepositoryModuleMock(mocks))
vi.mock('../../../github/rate-limit', () => modules.rateLimitModuleMock(mocks))

beforeEach(() => {
  vi.useFakeTimers()
  modules.resetPRRefreshCoordinatorMocks(mocks)
})
afterEach(() => {
  vi.useRealTimers()
})

it('scopes review interests to the owning socket and replaces its old route', async () => {
  const h = await harness()
  const { WORKTREE_REVIEW_METHODS } = await import('./worktree-review')
  const subscribe = WORKTREE_REVIEW_METHODS.find(
    (method) => method.name === 'worktree.review.subscribe'
  )
  const renew = WORKTREE_REVIEW_METHODS.find((method) => method.name === 'worktree.review.renew')
  const unsubscribe = WORKTREE_REVIEW_METHODS.find(
    (method) => method.name === 'worktree.review.unsubscribe'
  )
  if (!subscribe || !renew || !unsubscribe) {
    throw new Error('Missing review methods')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers use only the four runtime members supplied by the cache/real-subscription-registry fixture.
  const runtime = h.runtime as unknown as OrcaRuntimeService
  const context = { runtime, connectionId: 'socket-a', requestId: 'request-a' }
  mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
    kind: 'no-pr',
    fetchedAt: Date.now()
  }))
  await subscribe.handler({ worktree: 'id:wt-1' }, context, (frame) => h.frames.push(frame))
  const first = snapshots(h.frames)[0]
  if (!first) {
    throw new Error('Missing initial review snapshot')
  }
  const params = { subscriptionId: first.subscriptionId }
  expect(await renew.handler(params, { ...context, connectionId: 'socket-b' })).toEqual({
    renewed: false
  })
  expect(await unsubscribe.handler(params, { ...context, connectionId: 'socket-b' })).toEqual({
    unsubscribed: false
  })
  expect(h.cleanups.size).toBe(1)
  await subscribe.handler(
    { worktree: 'id:wt-1' },
    { ...context, requestId: 'replacement' },
    (frame) => h.frames.push(frame)
  )
  expect(h.cleanups.size).toBe(1)
  expect(await renew.handler(params, context)).toEqual({ renewed: false })
  const second = snapshots(h.frames).at(-1)
  if (!second) {
    throw new Error('Missing replacement snapshot')
  }
  expect(await unsubscribe.handler({ subscriptionId: second.subscriptionId }, context)).toEqual({
    unsubscribed: true
  })
  expect(h.cleanups.size).toBe(0)
  await vi.advanceTimersByTimeAsync(300_000)
  expect(mocks.getPRForBranchOutcomeMock).not.toHaveBeenCalled()
})
