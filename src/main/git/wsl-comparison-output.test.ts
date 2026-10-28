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

import { getBranchCompare } from './source-control/branch-compare'
import { getCommitCompare } from './source-control/commit-compare'
import { loadCommitChanges } from './source-control/branch-change-entries'
import { getHistory } from './history'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'

const nativePlatform = process.platform
const options = { wslDistro: 'Ubuntu' }
let repository: string
let base: string
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
  repository = await mkdtemp(join(tmpdir(), 'orca-wsl-compare-'))
  await git('init', '-q')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(repository, 'a.txt'), 'old a\n')
  await writeFile(join(repository, 'b.txt'), 'old b\n')
  await git('add', '.')
  await git('commit', '-qm', 'base')
  await git('branch', '-M', 'main')
  base = (await git('rev-parse', 'HEAD')).trim()
  await git('checkout', '-qb', 'feature')
  await writeFile(join(repository, 'a.txt'), 'new a\n')
  await writeFile(join(repository, 'b.txt'), 'new b\n')
  await git('add', '.')
  await git('commit', '-qm', 'feature')
  head = (await git('rev-parse', 'HEAD')).trim()
  indexBefore = await readFile(join(repository, '.git/index'))
})

afterAll(async () => {
  await rm(repository, { recursive: true, force: true })
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
  expect(await readFile(join(repository, '.git/index'))).toEqual(indexBefore)
  expect(await readFile(join(repository, 'a.txt'), 'utf8')).toBe('new a\n')
})

function shellTransport(withBanner: boolean): void {
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

const expectedEntries = [
  { path: 'a.txt', status: 'modified', added: 1, removed: 1 },
  { path: 'b.txt', status: 'modified', added: 1, removed: 1 }
]

describe.skipIf(nativePlatform === 'win32')('comparison reads through WSL login output', () => {
  it.each([false, true])('loads branch comparison, banner=%s', async (withBanner) => {
    shellTransport(withBanner)
    const result = await getBranchCompare(repository, 'main', options)
    expect(result.summary).toMatchObject({
      status: 'ready',
      baseOid: base,
      headOid: head,
      mergeBase: base,
      compareRef: 'feature',
      changedFiles: 2,
      commitsAhead: 1,
      commitsBehind: 0
    })
    expect(result.entries).toEqual(expectedEntries)
  })

  it.each([false, true])('loads commit comparison and parent, banner=%s', async (withBanner) => {
    shellTransport(withBanner)
    const result = await getCommitCompare(repository, head, options)
    expect(result.summary).toMatchObject({
      status: 'ready',
      commitOid: head,
      parentOid: base,
      changedFiles: 2
    })
    expect(result.entries).toEqual(expectedEntries)
  })

  it.each([false, true])('retains raw change records, banner=%s', async (withBanner) => {
    shellTransport(withBanner)
    expect(await loadCommitChanges(repository, base, head, options)).toEqual(expectedEntries)
  })

  it.each([false, true])(
    'loads history and reference identities, banner=%s',
    async (withBanner) => {
      shellTransport(withBanner)
      const result = await getHistory(repository, { ...options, baseRef: 'main', limit: 5 })
      expect(result.items.map((item) => item.id)).toEqual([head, base])
      expect(result.items.map((item) => item.subject)).toEqual(['feature', 'base'])
      expect(result.currentRef).toMatchObject({ id: 'refs/heads/feature', revision: head })
      expect(result.baseRef).toMatchObject({ id: 'refs/heads/main', revision: base })
    }
  )
})
