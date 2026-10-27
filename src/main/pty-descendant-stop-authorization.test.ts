import { it, expect, vi } from 'vitest'
import { killWithDescendantSweep } from './pty-descendant-termination'

it.each(['linux', 'win32'] as const)(
  'runs the last veto after %s process preparation and outside destructive finally',
  async (platform) => {
    const prepared = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const authorizeStop = vi.fn(async () => false)
    const killRoot = vi.fn()
    const terminateOwnedTree = vi.fn(() => 'terminated' as const)
    const killWindowsTree = vi.fn(async () => {})
    const sendSignal = vi.fn()
    const pending = killWithDescendantSweep(4242, killRoot, {
      platform,
      authorizeStop,
      killWindowsTree,
      terminateOwnedTree,
      sendSignal,
      readTable: async () => {
        prepared.resolve()
        await release.promise
        return {
          rows: [{ pid: 4242, ppid: 1, pgid: 4242, startedAt: 'Tue Jul 14 12:00:00 2026' }],
          capturedAtMs: Date.parse('Tue Jul 14 12:01:00 2026')
        }
      },
      verifyTreeKillTarget: async () => {
        prepared.resolve()
        await release.promise
        return 'own'
      }
    })
    const denied = expect(pending).rejects.toThrow('terminal_stop_declined')
    await prepared.promise
    expect(authorizeStop).not.toHaveBeenCalled()
    release.resolve()
    await denied
    expect(authorizeStop).toHaveBeenCalledOnce()
    expect(killRoot).not.toHaveBeenCalled()
    expect(terminateOwnedTree).not.toHaveBeenCalled()
    expect(killWindowsTree).not.toHaveBeenCalled()
    expect(sendSignal).not.toHaveBeenCalled()
  }
)
