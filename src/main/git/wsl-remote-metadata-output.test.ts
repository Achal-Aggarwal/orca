import { EventEmitter } from 'node:events'
import type * as ChildProcess from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const native = await importOriginal<typeof ChildProcess>()
  return {
    ...native,
    execFile: (...args: unknown[]) => execFileMock(native.execFile, ...args)
  }
})
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { getRemoteFileUrl } from './repo'
import { getRemoteFileTarget } from './repo-remote-file-target'
import { readRemoteUrl } from './remote-url-probe'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'

const nativePlatform = process.platform
const options = { wslDistro: 'Ubuntu' }
let repository: string
let head: string
let indexBefore: Buffer

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: repository })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}

beforeAll(async () => {
  repository = await mkdtemp(join(tmpdir(), 'orca-wsl-remote-'))
  await git('init', '-q')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(repository, 'file.txt'), 'published content\n')
  await git('add', '.')
  await git('commit', '-qm', 'base')
  await git('branch', '-M', 'main')
  head = (await git('rev-parse', 'HEAD')).trim()
  await git('remote', 'add', 'origin', 'https://github.com/org/repo.git')
  await git('update-ref', 'refs/remotes/origin/main', head)
  await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  await git('config', 'branch.main.remote', 'origin')
  await git('config', 'branch.main.merge', 'refs/heads/main')
  indexBefore = await readFile(join(repository, '.git/index'))
})

afterAll(async () => {
  await rm(repository, { recursive: true, force: true })
})

beforeEach(() => {
  execFileMock.mockReset()
  resetWslGitReadEnvironmentForTests()
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
  resetWslGitReadEnvironmentForTests()
  _resetGitAdmissionForTests()
  expect(await readFile(join(repository, '.git/index'))).toEqual(indexBefore)
  expect(await readFile(join(repository, 'file.txt'), 'utf8')).toBe('published content\n')
})

function shellTransport(withBanner: boolean): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  execFileMock.mockImplementation((nativeExec, command, args, execOptions, callback) => {
    expect(command).toBe('wsl.exe')
    const script = String(args.at(-1))
    if (script.includes('_orca_git_path=')) {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter()
      })
      queueMicrotask(() => {
        callback(Object.assign(new Error('profile requires login'), { code: 78 }), '', '')
        child.emit('close', 78)
      })
      return child
    }
    const prefix = withBanner ? "printf 'Distro login notice.\\n\\n'; " : ''
    return nativeExec(
      '/bin/sh',
      ['-c', prefix + script],
      { ...execOptions, cwd: repository },
      callback
    )
  })
}

describe.skipIf(nativePlatform === 'win32')('remote metadata through WSL login output', () => {
  for (const host of ['github.com', 'gitlab.com', 'bitbucket.org']) {
    it.each([false, true])(
      `retains ${host} remote and published file, banner=%s`,
      async (banner) => {
        const remoteUrl = `https://${host}/org/repo.git`
        await git('remote', 'set-url', 'origin', remoteUrl)
        shellTransport(banner)

        expect((await readRemoteUrl({ repoPath: repository, ...options }, 'origin'))?.trim()).toBe(
          remoteUrl
        )
        expect(await getRemoteFileTarget(repository, options)).toEqual({ remoteUrl, ref: head })
        const fileUrl = await getRemoteFileUrl(repository, 'file.txt', 1, undefined, options)
        const expected =
          host === 'github.com'
            ? `https://${host}/org/repo/blob/${head}/file.txt#L1`
            : host === 'gitlab.com'
              ? `https://${host}/org/repo/-/blob/${head}/file.txt#L1`
              : `https://${host}/org/repo/src/${head}/file.txt#file.txt-1`
        expect(fileUrl).toBe(expected)
      }
    )
  }
})
