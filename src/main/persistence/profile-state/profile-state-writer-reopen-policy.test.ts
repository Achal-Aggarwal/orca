import { describe, expect, it, vi } from 'vitest'
import { ProfileStateWriterReopenPolicy } from './profile-state-writer-reopen-policy'

const spawnFailure = Object.assign(new Error('spawn failed'), {
  code: 'profile-state-writer-unavailable'
})

describe('ProfileStateWriterReopenPolicy', () => {
  it('retries the first failure at once, then backs off up to a minute', () => {
    let now = 0
    const policy = new ProfileStateWriterReopenPolicy(() => now)
    expect(policy.recordFailure(spawnFailure)).toBe(true)
    expect(() => policy.admit()).not.toThrow()
    expect(policy.recordFailure(spawnFailure)).toBe(true)
    expect(() => policy.admit()).toThrow('spawn failed')
    now = 1_000
    expect(() => policy.admit()).not.toThrow()
    for (let failure = 0; failure < 10; failure += 1) {
      policy.recordFailure(spawnFailure)
    }
    now += 59_999
    expect(() => policy.admit()).toThrow('spawn failed')
    now += 1
    expect(() => policy.admit()).not.toThrow()
  })

  it('forgets the backoff once a reopen succeeds', () => {
    let now = 0
    const policy = new ProfileStateWriterReopenPolicy(() => now)
    policy.recordFailure(spawnFailure)
    policy.recordFailure(spawnFailure)
    policy.recordSuccess()
    expect(() => policy.admit()).not.toThrow()
    expect(policy.recordFailure(spawnFailure)).toBe(true)
    expect(() => policy.admit()).not.toThrow()
  })

  it('keeps a revision conflict terminal', () => {
    const policy = new ProfileStateWriterReopenPolicy(() => 0)
    expect(policy.recordFailure({ code: 'profile-state-revision-conflict' })).toBe(false)
    expect(() => policy.admit()).not.toThrow()
  })

  it('counts every attempt and logs at most once per ten minutes', () => {
    let now = 0
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const policy = new ProfileStateWriterReopenPolicy(() => now)
    policy.recordAttempt()
    now = 9 * 60_000
    policy.recordAttempt()
    now = 10 * 60_000
    policy.recordAttempt()
    expect(policy.count).toBe(3)
    expect(info).toHaveBeenCalledTimes(2)
    info.mockRestore()
  })
})
