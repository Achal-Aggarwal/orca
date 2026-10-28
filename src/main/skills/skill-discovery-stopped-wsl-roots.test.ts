import { describe, expect, it } from 'vitest'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../wsl/wsl-unc-access-gate'
import { unavailableWhileWslDistroStopped } from './skill-discovery-stopped-wsl-roots'

describe('unavailableWhileWslDistroStopped', () => {
  it.each([new WslDistroStoppedError('Ubuntu'), new WslDistroUnverifiableError('Ubuntu')])(
    'answers no skills and no sources for %s',
    async (refusal) => {
      await expect(
        unavailableWhileWslDistroStopped(() => Promise.reject(refusal))
      ).resolves.toMatchObject({ skills: [], sources: [] })
    }
  )

  it('passes results through and rethrows any other failure', async () => {
    const result = { skills: [], sources: [], scannedAt: 1 }
    await expect(unavailableWhileWslDistroStopped(async () => result)).resolves.toBe(result)
    await expect(
      unavailableWhileWslDistroStopped(() => Promise.reject(new Error('repair required')))
    ).rejects.toThrow('repair required')
  })
})
