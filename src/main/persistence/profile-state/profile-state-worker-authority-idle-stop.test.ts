import { describe, expect, it, vi } from 'vitest'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import { createWorkerMaintenanceFixture } from '../loading-store/profile-state-maintenance-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const IDLE_MS = 40

/** Resolves once the idle writer has fully closed. */
async function idleStopped(close: ReturnType<typeof vi.spyOn>, calls = 1): Promise<void> {
  await expect.poll(() => close.mock.calls.length, { timeout: 5_000 }).toBe(calls)
  await close.mock.results.at(-1)?.value
}

async function idleFixture(onFailure?: (error: Error) => void) {
  const close = vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'close')
  const fixture = await createWorkerMaintenanceFixture(undefined, onFailure, IDLE_MS)
  return { ...fixture, close }
}

describe('worker authority idle stop', () => {
  it('keeps the writer running when no idle stop is configured', async () => {
    const close = vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'close')
    const { authority } = await createWorkerMaintenanceFixture()
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 5))
    expect(close).not.toHaveBeenCalled()
    authority.assertWritable()
  })

  it('stops an idle writer, stays writable, and reopens it for the next write', async () => {
    const { authority, close, readState } = await idleFixture()
    await idleStopped(close)
    expect(() => authority.assertWritable()).not.toThrow()
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"after":"idle"}' }])
    expect(readState().ui).toEqual({ after: 'idle' })
    // The reopened writer idles out again.
    await idleStopped(close, 2)
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"after":"second"}' }])
    expect(readState().ui).toEqual({ after: 'second' })
  })

  it('lands a write that arrives while the stop is closing the writer', async () => {
    const { authority, close, readState } = await idleFixture()
    await expect.poll(() => close.mock.calls.length, { timeout: 5_000 }).toBe(1)
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"raced":true}' }])
    expect(readState().ui).toEqual({ raced: true })
  })

  it('refuses the next write when the database changed while the writer was stopped', async () => {
    const notify = vi.fn()
    const { authority, close, peer } = await idleFixture(notify)
    await idleStopped(close)
    const other = peer()
    other.writeSerializedDomains([{ domain: 'ui', payload: '{"external":true}' }])
    other.close()
    await expect(
      authority.writeSerializedDomains([{ domain: 'ui', payload: '{"mine":true}' }])
    ).rejects.toMatchObject({ code: 'profile-state-revision-conflict' })
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'profile-state-revision-conflict' })
    )
    expect(() => authority.assertWritable()).toThrow()
  })

  it('closes cleanly while stopped and refuses later writes', async () => {
    const { authority, close } = await idleFixture()
    await idleStopped(close)
    await authority.close()
    expect(() => authority.assertWritable()).toThrow('closing')
    await expect(
      authority.writeSerializedDomains([{ domain: 'ui', payload: '{}' }])
    ).rejects.toMatchObject({ code: 'profile-state-writer-closed' })
  })

  it('pauses for maintenance while stopped and resumes at the stopped revision', async () => {
    const { authority, close, readState } = await idleFixture()
    await idleStopped(close)
    const maintenance = await authority.pauseForMaintenance()
    await maintenance.resume()
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"resumed":true}' }])
    expect(readState().ui).toEqual({ resumed: true })
  })

  it('quarantines the database while stopped', async () => {
    const { authority, close } = await idleFixture()
    await idleStopped(close)
    await expect(authority.quarantineDatabase()).resolves.toBeDefined()
  })

  it('stays failed after an abort while stopped', async () => {
    const { authority, close } = await idleFixture()
    await idleStopped(close)
    await authority.abort()
    expect(() => authority.assertWritable()).toThrow('aborted')
    await expect(
      authority.writeSerializedDomains([{ domain: 'ui', payload: '{}' }])
    ).rejects.toMatchObject({ code: 'profile-state-writer-aborted' })
  })
})
