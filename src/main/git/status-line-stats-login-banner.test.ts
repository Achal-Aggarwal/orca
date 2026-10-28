import { EventEmitter } from 'node:events'
import type * as ChildProcess from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../shared/git-status-types'
import { invalidateGitBranchLineTotalInFlight } from '../../shared/git-branch-line-total'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: execFileMock
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { attachLineStats } from './source-control/status-line-stats'
import { createBranchLineTotalInput } from './source-control/status-branch-line-total-input'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'

const nativePlatform = process.platform
const banner = 'To run a command as administrator, use sudo.\n\n'
let repository: string
let stagedNumstat: string
let unstagedNumstat: string
let rangedNumstat: string
let mergeBase: string

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: repository })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}

beforeAll(async () => {
  repository = await mkdtemp(join(tmpdir(), 'orca-numstat-banner-'))
  await git('init', '-q')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(repository, 'a.txt'), 'old\ncontext\n')
  await writeFile(join(repository, 'b.txt'), 'old sibling\ncontext\n')
  await git('add', '.')
  await git('commit', '-qm', 'initial')
  mergeBase = (await git('rev-parse', 'HEAD')).trim()
  await writeFile(join(repository, 'a.txt'), 'staged one\nstaged two\ncontext\n')
  await writeFile(join(repository, 'b.txt'), 'staged sibling\ncontext\n')
  await git('add', '.')
  stagedNumstat = await git('diff', '-z', '--cached', '--numstat', '-M')
  await writeFile(join(repository, 'a.txt'), 'working one\nworking two\nworking three\ncontext\n')
  await writeFile(join(repository, 'b.txt'), 'working sibling\ncontext\n')
  unstagedNumstat = await git('diff', '-z', '--numstat', '-M')
  rangedNumstat = await git('diff', '-z', '--numstat', '-M', mergeBase, '--')
})

afterAll(async () => {
  await rm(repository, { recursive: true, force: true })
})

beforeEach(() => {
  execFileMock.mockReset()
  resetWslGitReadEnvironmentForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
  resetWslGitReadEnvironmentForTests()
  _resetGitAdmissionForTests()
  invalidateGitBranchLineTotalInFlight()
})

function shellTransport(withBanner: boolean): void {
  execFileMock.mockImplementation((_command, args, _options, callback) => {
    const script = String(args.at(-1))
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter()
    })
    if (script.includes('_orca_git_path=')) {
      // Git-relevant profile variables intentionally reject direct reads.
      queueMicrotask(() =>
        callback(Object.assign(new Error('profile requires login'), { code: 78 }), '', '')
      )
      return child
    }
    const payload = script.includes(mergeBase)
      ? rangedNumstat
      : script.includes('--cached')
        ? stagedNumstat
        : unstagedNumstat
    const nonce = /__ORCA_WSL_CAPTURE_BEGIN_ ([^_]+)__/.exec(script)?.[1]
    const output =
      (withBanner ? banner : '') +
      (nonce
        ? `__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${payload}__ORCA_WSL_CAPTURE_END_${nonce}__`
        : payload)
    queueMicrotask(() => callback(null, output, ''))
    return child
  })
}

describe('line stats through a required WSL login shell', () => {
  it.each([false, true])('retains the base-to-worktree total, banner=%s', async (withBanner) => {
    shellTransport(withBanner)
    const input = createBranchLineTotalInput(
      '/home/test/repository',
      [],
      { wslDistro: 'Ubuntu', branchLineTotalMergeBase: mergeBase },
      true
    )

    expect(await input?.compute()).toMatchObject({ added: 4, removed: 2, mergeBase })
  })

  it.each([
    { area: 'staged', withBanner: false, added: 2, removed: 1 },
    { area: 'unstaged', withBanner: false, added: 3, removed: 2 },
    { area: 'staged', withBanner: true, added: 2, removed: 1 },
    { area: 'unstaged', withBanner: true, added: 3, removed: 2 }
  ] as const)(
    'retains $area counts, banner=$withBanner',
    async ({ area, withBanner, added, removed }) => {
      shellTransport(withBanner)
      const entries: GitStatusEntry[] = [
        { path: 'a.txt', area, status: 'modified' },
        { path: 'b.txt', area, status: 'modified' }
      ]

      const complete = await attachLineStats('/home/test/repository', entries, {
        wslDistro: 'Ubuntu'
      })

      expect(entries[0]).toMatchObject({ added, removed })
      expect(entries[1]).toMatchObject({ added: 1, removed: 1 })
      expect(complete).toBe(true)
      expect(
        execFileMock.mock.calls.some(([, args]) => String(args.at(-1)).includes('_orca_git_path='))
      ).toBe(true)
      expect(await readFile(join(repository, 'a.txt'), 'utf8')).toBe(
        'working one\nworking two\nworking three\ncontext\n'
      )
    }
  )
})
