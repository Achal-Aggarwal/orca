import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { harness, snapshots } from './workspace-review-subscription.test-fixture'
import { makePR } from '../github/pr-refresh-coordinator-test-harness'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import type { WorkspaceReviewTarget } from './runtime-workspace-review-target'

const { mocks, modules } = await vi.hoisted(async () => {
  const modules = await import('../github/pr-refresh-coordinator-test-mocks')
  return { mocks: modules.createPRRefreshCoordinatorMocks(), modules }
})
vi.mock('./runtime-desktop-surface', () => modules.runtimeDesktopSurfaceModuleMock(mocks))
vi.mock('../github/client', () => modules.clientModuleMock(mocks))
vi.mock('../github/github-api-repository', () => modules.githubApiRepositoryModuleMock(mocks))
vi.mock('../github/rate-limit', () => modules.rateLimitModuleMock(mocks))

beforeEach(() => {
  modules.resetPRRefreshCoordinatorMocks(mocks)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('workspace review asynchronous ownership', () => {
  it('fences an old outcome as soon as a newer matching request starts', async () => {
    const h = await harness()
    let finishOld: (outcome: PRRefreshOutcome) => void = () => {}
    let finishNew: (outcome: PRRefreshOutcome) => void = () => {}
    mocks.getPRForBranchOutcomeMock
      .mockImplementationOnce(
        () =>
          new Promise<PRRefreshOutcome>((resolve) => {
            finishOld = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<PRRefreshOutcome>((resolve) => {
            finishNew = resolve
          })
      )
    const subscription = h.open()
    await subscription.renew()
    await vi.advanceTimersByTimeAsync(0)
    const newer = h.coordinator.refreshPRNow(h.candidate)
    await vi.advanceTimersByTimeAsync(0)
    finishOld({ kind: 'found', pr: makePR({ number: 12 }), fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.cache.pr[h.candidate.cacheKey]).toBeUndefined()
    finishNew({ kind: 'found', pr: makePR({ number: 13 }), fetchedAt: Date.now() })
    await newer
    await vi.advanceTimersByTimeAsync(0)
    expect(h.cache.pr[h.candidate.cacheKey]?.data?.number).toBe(13)
    subscription.close()
  })

  it('reconciles suppression changed while a same-identity lookup was running', async () => {
    const h = await harness()
    let finish: (outcome: PRRefreshOutcome) => void = () => {}
    mocks.getPRForBranchOutcomeMock.mockImplementationOnce(
      () =>
        new Promise<PRRefreshOutcome>((resolve) => {
          finish = resolve
        })
    )
    const subscription = h.open()
    await subscription.renew()
    await vi.advanceTimersByTimeAsync(0)
    const current = await h.prepare()
    h.prepare.mockResolvedValue({ ...current, linkedPR: null, suppressedGitHubPR: 12 })
    finish({ kind: 'found', pr: makePR({ number: 12 }), fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots(h.frames).at(-1)).toMatchObject({ review: null })
    expect(h.cache.pr[h.candidate.cacheKey]?.data?.number).toBe(12)
    subscription.close()
  })

  it('releases setup before awaited preparation can register interest after disconnect', async () => {
    const h = await harness()
    const target = await h.prepare()
    let finish: (target: WorkspaceReviewTarget) => void = () => {}
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const subscription = h.open()
    const started = subscription.renew()
    h.registry.releaseByRequest('mobile-socket', 'mobile-1')
    finish(target)
    expect(await started).toBe(false)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mocks.getPRForBranchOutcomeMock).not.toHaveBeenCalled()
    expect(snapshots(h.frames)).toHaveLength(0)
  })

  it('does not let an older failed renewal close a successful replacement', async () => {
    const h = await harness()
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    let fail: (error: Error) => void = () => {}
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    const subscription = h.open()
    const older = subscription.renew()
    expect(await subscription.renew()).toBe(true)
    fail(new Error('old preparation failed'))
    expect(await older).toBe(false)
    expect(h.cleanups.size).toBe(1)
    h.prepare.mockRejectedValueOnce(new Error('current preparation failed'))
    await expect(subscription.renew()).rejects.toThrow('current preparation failed')
    expect(h.cleanups.size).toBe(0)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mocks.getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })
})
