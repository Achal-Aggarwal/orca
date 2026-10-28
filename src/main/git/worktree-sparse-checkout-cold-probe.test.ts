import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { detectSparseCheckout } from './worktree-sparse-state'

const { detectSparseCheckoutMock } = vi.hoisted(() => ({
  detectSparseCheckoutMock: vi.fn<typeof detectSparseCheckout>()
}))

vi.mock('./worktree-sparse-state', () => ({
  detectSparseCheckout: detectSparseCheckoutMock
}))

import {
  __getSparseCheckoutStateCacheSizeForTests,
  __resetSparseCheckoutStateCacheForTests,
  clearSparseCheckoutStateCache,
  clearSparseCheckoutStateCacheForRepo,
  detectSparseCheckoutCached,
  invalidateSparseCheckoutState
} from './worktree-sparse-checkout-cache'

const invalidations = [
  { name: 'path', invalidate: () => invalidateSparseCheckoutState('/repo', '/repo/wt') },
  { name: 'repo', invalidate: () => clearSparseCheckoutStateCacheForRepo('/repo') },
  { name: 'all', invalidate: () => clearSparseCheckoutStateCache() }
]

beforeEach(() => {
  detectSparseCheckoutMock.mockReset()
  __resetSparseCheckoutStateCacheForTests()
})

describe.each(invalidations)('cold sparse probes across $name invalidation', ({ invalidate }) => {
  it('does not repopulate the cache after invalidation', async () => {
    let finishOldProbe = (_value: boolean): void => {}
    detectSparseCheckoutMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishOldProbe = resolve))
    )
    const oldRead = detectSparseCheckoutCached('/repo', '/repo/wt')
    invalidate()

    finishOldProbe(false)
    expect(await oldRead).toBe(false)
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(0)

    detectSparseCheckoutMock.mockResolvedValueOnce(true)
    expect(await detectSparseCheckoutCached('/repo', '/repo/wt')).toBe(true)
    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)
  })

  it('preserves a fresh answer after an old cold probe settles last', async () => {
    let finishOldProbe = (_value: boolean): void => {}
    detectSparseCheckoutMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishOldProbe = resolve))
    )
    const oldRead = detectSparseCheckoutCached('/repo', '/repo/wt')
    invalidate()

    detectSparseCheckoutMock.mockResolvedValueOnce(true)
    expect(await detectSparseCheckoutCached('/repo', '/repo/wt')).toBe(true)
    finishOldProbe(false)
    expect(await oldRead).toBe(false)

    expect(await detectSparseCheckoutCached('/repo', '/repo/wt')).toBe(true)
    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)
  })
})

it('preserves cold probes in other repos and distro identities during scoped invalidation', async () => {
  let finishProbe = (_value: boolean): void => {}
  const pending = new Promise<boolean>((resolve) => (finishProbe = resolve))
  detectSparseCheckoutMock.mockReturnValue(pending)
  const siblingRepo = detectSparseCheckoutCached('/other', '/other/wt')
  const siblingDistro = detectSparseCheckoutCached('/repo', '/repo/wt', { wslDistro: 'Ubuntu' })
  const removed = detectSparseCheckoutCached('/repo', '/repo/removed')
  const removedDistro = detectSparseCheckoutCached('/repo', '/repo/removed', {
    wslDistro: 'Ubuntu'
  })

  invalidateSparseCheckoutState('/repo', '/repo/removed')
  clearSparseCheckoutStateCacheForRepo('/unrelated')
  finishProbe(true)

  expect(await siblingRepo).toBe(true)
  expect(await siblingDistro).toBe(true)
  expect(await removed).toBe(true)
  expect(await removedDistro).toBe(true)
  expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(2)
  expect(await detectSparseCheckoutCached('/other', '/other/wt')).toBe(true)
  expect(await detectSparseCheckoutCached('/repo', '/repo/wt', { wslDistro: ' ubuntu ' })).toBe(
    true
  )
  expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(4)
})
