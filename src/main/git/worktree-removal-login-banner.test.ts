import { EventEmitter } from 'node:events'
import type * as ChildProcess from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: execFileMock
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { assertWorktreeCleanForRemoval } from './worktree-removal-preflight'
import { formatWorktreeRemovalError } from '../ipc/worktree-logic'
import { classifyWorktreeForceDeleteReason } from '../../shared/worktree/removal'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'

const nativePlatform = process.platform
const options = { wslDistro: 'Ubuntu' }
const banner = 'To run a command as administrator, use sudo.\n\n'
let scratch: string
let checkout: string
let cleanStatus: string
let sharedLinkStatus: string
let dirtyStatus: string
let submoduleStatus: string
let submoduleConfig: string
let indexPath: string
let indexBefore: Buffer

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}

async function initializeRepository(path: string): Promise<void> {
  await mkdir(path)
  await git(path, 'init', '-q')
  await git(path, 'config', 'user.name', 'Test')
  await git(path, 'config', 'user.email', 'test@example.test')
  await git(path, 'config', 'commit.gpgsign', 'false')
  await git(path, 'config', 'core.hooksPath', '')
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orca-removal-banner-'))
  const repository = join(scratch, 'main')
  checkout = join(scratch, 'checkout')
  await initializeRepository(repository)
  await writeFile(join(repository, 'file.txt'), 'original\n')
  await git(repository, 'add', '.')
  await git(repository, 'commit', '-qm', 'initial')
  await git(repository, 'worktree', 'add', '-qb', 'feature', checkout)
  cleanStatus = await git(checkout, 'status', '--porcelain', '--untracked-files=all')
  await writeFile(join(checkout, 'shared-link'), 'shared target\n')
  sharedLinkStatus = await git(checkout, 'status', '--porcelain', '-z', '--untracked-files=all')
  await writeFile(join(checkout, 'file.txt'), 'changed work\n')
  dirtyStatus = await git(checkout, 'status', '--porcelain', '-z', '--untracked-files=all')
  const vendor = join(checkout, 'vendor')
  await initializeRepository(vendor)
  await writeFile(join(vendor, 'child.txt'), 'child original\n')
  await git(vendor, 'add', '.')
  await git(vendor, 'commit', '-qm', 'child')
  await writeFile(
    join(checkout, '.gitmodules'),
    '[submodule "vendor"]\n\tpath = vendor\n\turl = ../vendor-origin\n'
  )
  await git(checkout, 'add', '.gitmodules', 'vendor')
  await git(checkout, 'commit', '-qm', 'add populated submodule')
  await writeFile(join(vendor, 'child.txt'), 'submodule unpushed work\n')
  submoduleStatus = await git(checkout, 'status', '--porcelain', '--ignore-submodules=none')
  submoduleConfig = await git(
    checkout,
    'config',
    '-z',
    '--file',
    '.gitmodules',
    '--get-regexp',
    '^submodule\\..*\\.path$'
  )
  indexPath = (await git(checkout, 'rev-parse', '--git-path', 'index')).trim()
  indexBefore = await readFile(indexPath)
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  execFileMock.mockReset()
  resetWslGitReadEnvironmentForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
  resetWslGitReadEnvironmentForTests()
  _resetGitAdmissionForTests()
  expect(await readFile(indexPath)).toEqual(indexBefore)
  expect(await readFile(join(checkout, 'file.txt'), 'utf8')).toBe('changed work\n')
  expect(await readFile(join(checkout, 'vendor', 'child.txt'), 'utf8')).toBe(
    'submodule unpushed work\n'
  )
})

function shellTransport(status: string, withBanner: boolean, config = ''): void {
  execFileMock.mockImplementation((_command, args, _options, callback) => {
    const script = String(args.at(-1))
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter()
    })
    if (script.includes('_orca_git_path=')) {
      queueMicrotask(() =>
        callback(Object.assign(new Error('profile requires login'), { code: 78 }), '', '')
      )
      return child
    }
    const isConfig = script.includes('.gitmodules')
    const payload = isConfig ? config : status
    const error =
      isConfig && !config ? Object.assign(new Error('no .gitmodules'), { code: 1 }) : null
    const nonce = /__ORCA_WSL_CAPTURE_BEGIN_ ([^_]+)__/.exec(script)?.[1]
    const output =
      (withBanner ? banner : '') +
      (nonce
        ? `__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${payload}__ORCA_WSL_CAPTURE_END_${nonce}__`
        : payload)
    queueMicrotask(() => callback(error, output, ''))
    return child
  })
}

describe('worktree removal preflight through a required WSL login shell', () => {
  it.each([false, true])('accepts a clean checkout, banner=%s', async (withBanner) => {
    shellTransport(cleanStatus, withBanner)

    await expect(assertWorktreeCleanForRemoval(checkout, false, options)).resolves.toBeUndefined()
  })

  it.each([false, true])(
    'tolerates only the configured shared path, banner=%s',
    async (withBanner) => {
      shellTransport(sharedLinkStatus, withBanner)

      await expect(
        assertWorktreeCleanForRemoval(checkout, false, {
          ...options,
          ignoredUntrackedPaths: ['shared-link']
        })
      ).resolves.toBeUndefined()
    }
  )

  it.each([false, true])('refuses actual dirty files, banner=%s', async (withBanner) => {
    shellTransport(dirtyStatus, withBanner)

    const error = await assertWorktreeCleanForRemoval(checkout, false, {
      ...options,
      ignoredUntrackedPaths: ['shared-link']
    }).catch((error: unknown) => error)
    const message = formatWorktreeRemovalError(error, checkout, false)
    expect(classifyWorktreeForceDeleteReason(message)).toBe('dirty')
    expect(message).toContain(' M file.txt')
    expect(message).not.toContain(banner.trim())
  })

  it.each([false, true])(
    'preserves the populated submodule warning, banner=%s',
    async (withBanner) => {
      shellTransport(submoduleStatus, withBanner, submoduleConfig)

      const error = await assertWorktreeCleanForRemoval(checkout, false, options).catch(
        (error: unknown) => error
      )
      const message = formatWorktreeRemovalError(error, checkout, false)
      expect(classifyWorktreeForceDeleteReason(message)).toBe('submodules')
      expect(message).toContain(' M vendor')
      expect(message).not.toContain(banner.trim())
    }
  )

  it('keeps explicit force removal free of Git preflight reads', async () => {
    await expect(assertWorktreeCleanForRemoval(checkout, true, options)).resolves.toBeUndefined()

    expect(execFileMock).not.toHaveBeenCalled()
  })
})
