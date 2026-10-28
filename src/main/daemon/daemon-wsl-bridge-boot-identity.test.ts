import { describe, expect, it, vi } from 'vitest'
import { WslBridgeBootIdentity } from './daemon-wsl-bridge-boot-identity'

function identity(options: { running?: boolean; ids?: (string | null)[] } = {}) {
  const ids = [...(options.ids ?? ['boot-1'])]
  const isRunning = vi.fn(async () => options.running ?? true)
  const readBootId = vi.fn(async () => (ids.length > 1 ? ids.shift()! : (ids[0] ?? null)))
  return { boot: new WslBridgeBootIdentity({ isRunning, readBootId }), isRunning, readBootId }
}

describe('WslBridgeBootIdentity', () => {
  it('reads each distro once while any of its panes lives', async () => {
    const { boot, readBootId } = identity()
    boot.noteSpawn('a', 'Ubuntu')
    boot.noteSpawn('b', 'ubuntu')
    boot.noteSpawn('a', 'Ubuntu')
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledOnce())
  })

  it('calls an exit rebooted only when the distro booted again since the spawn', async () => {
    const same = identity({ ids: ['boot-1'] })
    same.boot.noteSpawn('a', 'Ubuntu')
    await expect(same.boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(false)

    const again = identity({ ids: ['boot-1', 'boot-2'] })
    again.boot.noteSpawn('a', 'Ubuntu')
    await expect(again.boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(true)
  })

  it('falls back to an exit when either id is unreadable, or the pane was never noted', async () => {
    for (const ids of [
      [null, 'boot-2'],
      ['boot-1', null]
    ]) {
      const { boot } = identity({ ids })
      boot.noteSpawn('a', 'Ubuntu')
      await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(false)
    }
    await expect(identity().boot.rebootedSinceSpawn('unknown', 'Ubuntu')).resolves.toBe(false)
  })

  it('never reads a distro the background-work gate does not confirm running (E9)', async () => {
    const { boot, readBootId } = identity({ running: false })
    boot.noteSpawn('a', 'Ubuntu')
    await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(false)
    expect(readBootId).not.toHaveBeenCalled()
  })

  it('reads again for a spawn after an exit, or after its last pane went away', async () => {
    const { boot, readBootId } = identity({ ids: ['boot-1', 'boot-2', 'boot-3', 'boot-4'] })
    boot.noteSpawn('a', 'Ubuntu')
    await boot.rebootedSinceSpawn('a', 'Ubuntu')
    boot.forget('a')
    boot.noteSpawn('b', 'Ubuntu')
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledTimes(3))
    boot.forget('b')
    boot.noteSpawn('c', 'Ubuntu')
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledTimes(4))
  })

  it('treats a failing read as unreadable', async () => {
    const boot = new WslBridgeBootIdentity({
      isRunning: async () => true,
      readBootId: async () => {
        throw new Error('wsl.exe failed')
      }
    })
    boot.noteSpawn('a', 'Ubuntu')
    await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(false)
  })
})
