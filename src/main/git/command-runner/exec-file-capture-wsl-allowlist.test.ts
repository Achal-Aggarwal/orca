import type * as ChildProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, workerExecFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  workerExecFileMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFile: execFileMock
}))
vi.mock('./worker-exec-file', () => ({ workerExecFile: workerExecFileMock }))

import { execFileCapture } from './exec-file-capture'

const ALLOWLIST = 'ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST'

describe('execFileCapture under the internal WSL distro allowlist', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    execFileMock.mockReset()
    workerExecFileMock.mockReset()
  })

  it('refuses a WSL Git call into another distro before any child starts', async () => {
    vi.stubEnv(ALLOWLIST, 'orca-test-a')
    const onChildTerminated = vi.fn()

    await expect(
      execFileCapture('wsl.exe', ['-d', 'Ubuntu', '--exec', 'git', 'status'], {
        encoding: 'utf8',
        onChildTerminated
      })
    ).rejects.toMatchObject({ code: 'ORCA_WSL_DISTRO_NOT_ALLOWLISTED' })
    expect(execFileMock).not.toHaveBeenCalled()
    expect(workerExecFileMock).not.toHaveBeenCalled()
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it.each([
    ['unset', undefined, 'Ubuntu'],
    ['allowlisted', 'orca-test-a', 'orca-test-a']
  ])('spawns as before when the allowlist is %s', (_label, allowlist, distro) => {
    vi.stubEnv(ALLOWLIST, allowlist)
    execFileMock.mockReturnValue({ once: vi.fn(), on: vi.fn(), stderr: null })

    void execFileCapture('wsl.exe', ['-d', distro, '--exec', 'git', 'status'], {
      encoding: 'utf8'
    }).catch(() => {})

    expect(execFileMock).toHaveBeenCalledOnce()
  })
})
