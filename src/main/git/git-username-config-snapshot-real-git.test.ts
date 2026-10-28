import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunnerModule from './runner'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const ghExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('./runner', async () => ({
  ...(await vi.importActual<typeof RunnerModule>('./runner')),
  gitExecFileAsync: gitExecFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock
}))

import { resolveLocalGitUsernameDetailed } from './git-username'

let root = ''
let repoPath = ''

async function git(args: string[], cwd = repoPath): Promise<{ stdout: string; stderr: string }> {
  const result = await runProcess({ program: 'git', args, cwd })
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr), result)
  }
  return result
}

beforeEach(async () => {
  vi.resetAllMocks()
  root = await mkdtemp(join(tmpdir(), 'orca-username-config-'))
  repoPath = join(root, 'repo with spaces')
  await mkdir(repoPath)
  const globalConfig = join(root, 'global.gitconfig')
  await writeFile(globalConfig, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  await git(['init', '--quiet'])
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  gitExecFileAsyncMock.mockImplementation((args: string[], options: { cwd: string }) =>
    git(args, options.cwd)
  )
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('Git username config snapshot with real Git', () => {
  it('preserves includes and last-value overrides, and reloads changed config for the next resolution', async () => {
    const includedConfig = join(root, 'included settings.gitconfig')
    await writeFile(includedConfig, '[github]\n\tuser = 42+included-user@example.test\n')
    await git(['config', '--global', 'github.user', 'global-user'])
    await git(['config', 'include.path', includedConfig])
    await git(['config', '--add', 'github.user', 'local-first'])
    await git(['config', '--add', 'github.user', 'local-last'])

    expect((await git(['config', '--get', 'github.user'])).stdout.trim()).toBe('local-last')
    await expect(resolveLocalGitUsernameDetailed(repoPath)).resolves.toEqual({
      username: 'local-last',
      authoritative: true
    })
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      ['config', '--list', '-z']
    ])

    await git(['config', '--unset-all', 'github.user'])
    await expect(resolveLocalGitUsernameDetailed(repoPath)).resolves.toEqual({
      username: 'included-user',
      authoritative: true
    })
    await writeFile(includedConfig, '[github]\n\tuser = changed-user\n')
    await expect(resolveLocalGitUsernameDetailed(repoPath)).resolves.toEqual({
      username: 'changed-user',
      authoritative: true
    })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('retains individual config lookup fallback when snapshot loading fails', async () => {
    await git(['config', 'user.username', 'fallback-user'])
    gitExecFileAsyncMock.mockImplementation((args: string[], options: { cwd: string }) => {
      if (args[0] === 'config' && args[1] === '--list') {
        throw new Error('snapshot unavailable')
      }
      return git(args, options.cwd)
    })

    await expect(resolveLocalGitUsernameDetailed(repoPath)).resolves.toEqual({
      username: 'fallback-user',
      authoritative: true
    })
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      ['config', '--list', '-z'],
      ['config', '--get', 'github.user'],
      ['config', '--get', 'user.username']
    ])
  })

  it('resolves the author fallback with one config child when current and default branch match', async () => {
    await git(['config', 'user.name', 'fixture-user'])
    await git(['config', 'user.email', 'fixture@example.test'])
    await git(['config', 'commit.gpgSign', 'false'])
    await git(['config', 'core.hooksPath', '.git/no-hooks'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'fixture'])
    await git(['remote', 'add', 'origin', 'https://gitlab.com/example/repository.git'])
    await git(['config', 'branch.main.remote', 'origin'])
    await git(['config', 'branch.main.merge', 'refs/heads/main'])

    await expect(resolveLocalGitUsernameDetailed(repoPath)).resolves.toEqual({
      username: 'fixture-user',
      authoritative: true
    })
    expect(gitExecFileAsyncMock.mock.calls).toHaveLength(5)
    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'config').map(([args]) => args)
    ).toEqual([['config', '--list', '-z']])
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
