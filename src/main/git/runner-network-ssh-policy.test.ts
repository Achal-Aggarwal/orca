import { fakeSpawnDispatch } from '../../shared/__fixtures__/fake-spawned-child'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: spawnMock
}))

import { gitExecFileAsync } from './runner'
import {
  GitAdmissionScheduler,
  _resetGitAdmissionForTests
} from './command-runner/git-subprocess-admission'

beforeEach(() => {
  spawnMock.mockReset()
})
afterEach(() => _resetGitAdmissionForTests())

describe('network Git SSH policy', () => {
  it('probes core.sshCommand for opted-in network git calls', async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    spawnMock.mockImplementation(
      fakeSpawnDispatch((_cmd, args, opts) => {
        calls.push({ args: [...args], env: opts.env ?? {} })
        return {
          stdout:
            args[0] === 'config'
              ? 'core.sshcommand\nssh -F ~/.ssh/github-work -i ~/.ssh/work_key\0'
              : ''
        }
      })
    )

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(calls[0]?.args).toEqual([
      'config',
      '--null',
      '--get-regexp',
      '^(core\\.sshcommand|ssh\\.variant)$'
    ])
    expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(calls[0]?.env.GIT_SSH_COMMAND).toBeUndefined()
    expect(calls[1]?.args).toEqual(['fetch', 'origin'])
    expect(calls[1]?.env.GIT_SSH_COMMAND).toBe(
      'ssh -o BatchMode=yes -F ~/.ssh/github-work -i ~/.ssh/work_key'
    )
  })

  it('admits the core.sshCommand probe before spawning it', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    _resetGitAdmissionForTests(scheduler)
    const blocker = await scheduler.acquire({ args: ['status'], cwd: '/repo', tier: 'status' })
    const calls: string[][] = []
    spawnMock.mockImplementation(
      fakeSpawnDispatch((_cmd, args) => {
        calls.push([...args])
        return {}
      })
    )

    const pending = gitExecFileAsync(['fetch', '--no-write-fetch-head', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })
    await Promise.resolve()
    expect(spawnMock).not.toHaveBeenCalled()

    blocker.release()
    await pending

    expect(calls).toEqual([
      ['config', '--null', '--get-regexp', '^(core\\.sshcommand|ssh\\.variant)$'],
      ['fetch', '--no-write-fetch-head', 'origin']
    ])
  })

  it('replaces configured BatchMode for opted-in mergeable OpenSSH commands', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnMock.mockImplementation(
      fakeSpawnDispatch((_cmd, args, opts) => {
        if (args[0] === 'config') {
          return { stdout: 'core.sshcommand\nssh -o BatchMode=no -i ~/.ssh/personal\0' }
        }
        capturedEnv = opts.env
        return {}
      })
    )

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_SSH_COMMAND).toBe(
      'ssh -o BatchMode=yes -o BatchMode=no -i ~/.ssh/personal'
    )
  })

  it('merges quoted ssh.exe command shapes for opted-in network calls', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnMock.mockImplementation(
      fakeSpawnDispatch((_cmd, args, opts) => {
        if (args[0] === 'config') {
          return {
            stdout: 'core.sshcommand\n"C:/Program Files/Git/usr/bin/ssh.exe" -F ~/.ssh/config\0'
          }
        }
        capturedEnv = opts.env
        return {}
      })
    )

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_SSH_COMMAND).toBe(
      '"C:/Program Files/Git/usr/bin/ssh.exe" -o BatchMode=yes -F ~/.ssh/config'
    )
  })

  it('merges unquoted Windows ssh.exe paths for opted-in network calls', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnMock.mockImplementation(
      fakeSpawnDispatch((_cmd, args, opts) => {
        if (args[0] === 'config') {
          return {
            stdout: `core.sshcommand\n${String.raw`C:\Git\usr\bin\ssh.exe -i C:\Users\me\.ssh\work_key`}\0`
          }
        }
        capturedEnv = opts.env
        return {}
      })
    )

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_SSH_COMMAND).toBe(
      String.raw`'C:\Git\usr\bin\ssh.exe' -o BatchMode=yes -i 'C:\Users\me\.ssh\work_key'`
    )
  })

  it('passes through unmergeable core.sshCommand wrappers without generic fallback', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnMock.mockImplementation(
      fakeSpawnDispatch((_cmd, args, opts) => {
        if (args[0] === 'config') {
          return { stdout: 'core.sshcommand\n/usr/local/bin/work-ssh-wrapper --account work\0' }
        }
        capturedEnv = opts.env
        return {}
      })
    )

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(capturedEnv?.GIT_ASKPASS).toBe('')
    expect(capturedEnv?.SSH_ASKPASS).toBe('')
    expect(capturedEnv?.GIT_SSH_COMMAND).toBeUndefined()
  })

  it('passes through shell-expanding OpenSSH configs without changing expansion semantics', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnMock.mockImplementation(
      fakeSpawnDispatch((_cmd, args, opts) => {
        if (args[0] === 'config') {
          return { stdout: 'core.sshcommand\nssh -i "$HOME/.ssh/work_key"\0' }
        }
        capturedEnv = opts.env
        return {}
      })
    )

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(capturedEnv?.GIT_SSH_COMMAND).toBeUndefined()
  })

  it('falls back to generic batch-mode SSH when opted-in config is unset', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnMock.mockImplementation(
      fakeSpawnDispatch((_cmd, args, opts) => {
        if (args[0] === 'config') {
          return { code: 1 }
        }
        capturedEnv = opts.env
        return {}
      })
    )

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
  })

  it.each([
    { GIT_SSH_COMMAND: 'custom-ssh -o IdentityAgent=none' },
    { GIT_SSH: 'custom-ssh-wrapper' }
  ])('preserves explicit SSH environment and skips the config probe (%j)', async (env) => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnMock.mockImplementation(
      fakeSpawnDispatch((_cmd, _args, opts) => {
        capturedEnv = opts.env
        return {}
      })
    )

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env,
      useConfiguredSshCommandForNetwork: true
    })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(capturedEnv?.GIT_SSH_COMMAND).toBe(env.GIT_SSH_COMMAND)
    expect(capturedEnv?.GIT_SSH).toBe(env.GIT_SSH)
    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it.each(['ETIMEDOUT', 'ENOBUFS', 'ABORT_ERR'])(
    'does not select a generic SSH command after a %s config failure',
    async (code) => {
      const error = Object.assign(new Error('SSH configuration unavailable'), { code })
      spawnMock.mockImplementation(
        fakeSpawnDispatch(() => {
          return { spawnError: error }
        })
      )
      await expect(gitExecFileAsync(['fetch', 'origin'], { cwd: '/repo', env: {} })).rejects.toBe(
        error
      )
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock.mock.calls[0]?.[1]?.[0]).toBe('config')
    }
  )
})
