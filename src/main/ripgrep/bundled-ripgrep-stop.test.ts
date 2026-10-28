import { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { signalProcessTreeMock } = vi.hoisted(() => ({ signalProcessTreeMock: vi.fn() }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalProcessTreeMock
}))

import { stopBundledRipgrep } from './bundled-ripgrep-stop'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  signalProcessTreeMock.mockReset()
})

describe('stopBundledRipgrep', () => {
  it.each(['synchronous-error', 'queued-error', 'reject', 'throw'] as const)(
    'absorbs WSL tree termination failures when the tree signal uses %s',
    async (termination) => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const child = new ChildProcess()
      Object.defineProperty(child, 'pid', { value: 1 })
      const error = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
        child.emit('error', error)
        return false
      })
      signalProcessTreeMock.mockImplementation(() => {
        if (termination === 'throw') {
          throw error
        }
        if (termination === 'reject') {
          return Promise.reject(error)
        }
        if (termination === 'synchronous-error') {
          child.emit('error', error)
        } else {
          queueMicrotask(() => child.emit('error', error))
        }
        return Promise.resolve(false)
      })

      expect(() => stopBundledRipgrep(child, true)).not.toThrow()
      await Promise.resolve()
      stopBundledRipgrep(child, true)
      expect(signalProcessTreeMock).toHaveBeenCalledOnce()
      expect(kill).toHaveBeenCalledTimes(
        termination === 'reject' || termination === 'throw' ? 1 : 0
      )
      expect(child.listenerCount('error')).toBe(0)
    }
  )
})
