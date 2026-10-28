import { runProcess } from '@orca/process-host'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeExecOptions } from './worktree-operation-options'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  translateWslOutputPaths: (output: string) => output
}))
vi.mock('./git-capability-state', async () => {
  const { GitCapabilityCache } = await import('../../shared/git-capability-cache')
  return {
    withLocalGitCapabilityCacheForExecution: (
      _target: unknown,
      run: (cache: InstanceType<typeof GitCapabilityCache>) => Promise<unknown>
    ) => run(new GitCapabilityCache())
  }
})
vi.mock('./status', async () => import('./source-control/resolve-git-dir'))

import { listWorktreesStrict } from './worktree-listing'

let root = ''
let repo = ''
let crlfOutput = false
let afterLegacyOutput: (() => Promise<void>) | undefined

async function git(args: string[], cwd = repo, options: GitWorktreeExecOptions = {}) {
  const result = await runProcess({
    program: 'git',
    args,
    cwd,
    signal: options.signal,
    timeoutMs: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'missing-config'),
      GIT_AUTHOR_NAME: 'Worktree Test',
      GIT_AUTHOR_EMAIL: 'worktree@example.invalid',
      GIT_COMMITTER_NAME: 'Worktree Test',
      GIT_COMMITTER_EMAIL: 'worktree@example.invalid'
    }
  })
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr), {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    })
  }
  return result
}

async function initialize(repoName = 'repo', initArgs: string[] = []) {
  repo = join(root, repoName)
  await mkdir(repo)
  await git(['init', '-q', ...initArgs])
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  if (!initArgs.includes('--bare')) {
    await git([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=',
      'commit',
      '--allow-empty',
      '-qm',
      'initial'
    ])
  }
  repo = await realpath(repo)
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-legacy-worktree-path-')))
  afterLegacyOutput = undefined
  crlfOutput = false
  gitExecFileAsyncMock.mockImplementation(
    async (args: string[], options: GitWorktreeExecOptions & { cwd: string }) => {
      if (args.includes('-z')) {
        throw Object.assign(new Error("error: unknown switch 'z'"), { code: 129 })
      }
      const result = await git(args, options.cwd, options)
      if (args.join(' ') === 'worktree list --porcelain') {
        await afterLegacyOutput?.()
        if (crlfOutput) {
          result.stdout = result.stdout.replace(/\n/g, '\r\n')
        }
      }
      return result
    }
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')(
  'legacy worktree paths with real Git metadata',
  () => {
    it('keeps exact paths and locks despite identical first lines, branches and detached OIDs', async () => {
      await initialize()
      const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
      const names = [
        'same\nfirst',
        'same\nsecond',
        'detached\nfirst',
        'detached\nsecond',
        'blank\n\ncontinuation',
        `syntax\nHEAD ${'f'.repeat(40)}\nbranch refs/heads/phantom\nworktree phantom`,
        'carriage\rreturn',
        'trailing ',
        'plain'
      ]
      const paths = names.map((name) => join(root, name))
      for (const [index, worktreePath] of paths.entries()) {
        await git([
          'worktree',
          'add',
          '-q',
          '--force',
          ...(index === 2 || index === 3 ? ['--detach'] : []),
          worktreePath,
          'main'
        ])
      }
      await git(['worktree', 'lock', '--reason', 'keep exact first', paths[0]])
      await git(['worktree', 'lock', '--reason', 'keep exact second', paths[3]])
      await rm(paths[3], { recursive: true })
      await rm(paths[8], { recursive: true })
      await git(['pack-refs', '--all'])

      const rows = await listWorktreesStrict(repo)

      expect(rows.map((row) => row.path).sort()).toEqual([repo, ...paths].sort())
      for (const [index, worktreePath] of paths.entries()) {
        expect(rows.find((row) => row.path === worktreePath)).toMatchObject({
          head,
          branch: index === 2 || index === 3 ? '' : 'refs/heads/main',
          isBare: false,
          isMainWorktree: false,
          ...(index === 0 ? { locked: true, lockReason: 'keep exact first' } : {}),
          ...(index === 3 ? { locked: true, lockReason: 'keep exact second' } : {}),
          ...(index === 8 ? { prunable: true } : {})
        })
      }
      expect(
        rows
          .filter((row) => row.locked)
          .map((row) => row.path)
          .sort()
      ).toEqual([paths[0], paths[3]].sort())
      expect(rows.filter((row) => row.prunable).map((row) => row.path)).toEqual([paths[8]])
    })

    it('consumes a main path containing blank lines and record fields before parsing its HEAD', async () => {
      await initialize('repo\n\nHEAD fake\nworktree phantom')
      const linked = join(root, 'linked')
      await git(['worktree', 'add', '-q', '-b', 'linked', linked])
      const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()

      const rows = await listWorktreesStrict(repo)

      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        path: repo,
        head,
        branch: 'refs/heads/main',
        isMainWorktree: true
      })
      expect(rows[1]).toMatchObject({
        path: linked,
        head,
        branch: 'refs/heads/linked',
        isMainWorktree: false
      })
    })

    it.each(['gitdir', 'HEAD', 'branch-ref'] as const)(
      'rejects ambiguous listing when %s metadata is missing',
      async (missing) => {
        await initialize()
        const linked = join(root, 'line\nbreak')
        await git(['worktree', 'add', '-q', '-b', 'linked', linked])
        const marker = await readFile(join(linked, '.git'), 'utf8')
        const admin = marker.slice('gitdir: '.length).trim()
        afterLegacyOutput = () =>
          rm(
            missing === 'branch-ref'
              ? join(repo, '.git', 'refs', 'heads', 'linked')
              : join(admin, missing)
          )

        await expect(listWorktreesStrict(repo)).rejects.toThrow(
          'Cannot verify a legacy linked worktree'
        )
      }
    )

    it.each(['unreadable HEAD', 'duplicate backlink', 'symlinked registration'])(
      'rejects %s instead of publishing uncertain linked identities',
      async (invalid) => {
        await initialize()
        const linked = join(root, 'line\nbreak')
        await git(['worktree', 'add', '-q', '-b', 'linked', linked])
        const admin = (await readFile(join(linked, '.git'), 'utf8')).slice('gitdir: '.length).trim()
        afterLegacyOutput = async () => {
          if (invalid === 'unreadable HEAD') {
            await rm(join(admin, 'HEAD'))
            await mkdir(join(admin, 'HEAD'))
          } else {
            const duplicate = join(repo, '.git', 'worktrees', 'duplicate')
            if (invalid === 'symlinked registration') {
              await symlink(admin, duplicate)
            } else {
              await mkdir(duplicate)
              await writeFile(join(duplicate, 'gitdir'), await readFile(join(admin, 'gitdir')))
              await writeFile(join(duplicate, 'HEAD'), await readFile(join(admin, 'HEAD')))
            }
          }
        }

        await expect(listWorktreesStrict(repo)).rejects.toThrow('Cannot verify')
      }
    )

    it('propagates cancellation after receiving legacy output', async () => {
      await initialize()
      const controller = new AbortController()
      const reason = new Error('cancel legacy scan')
      afterLegacyOutput = async () => {
        controller.abort(reason)
      }

      await expect(listWorktreesStrict(repo, { signal: controller.signal })).rejects.toBe(reason)
    })

    it('retains the physical primary path when scanning a symlink to the repository', async () => {
      await initialize()
      const alias = join(root, 'alias')
      await symlink(repo, alias)

      await expect(listWorktreesStrict(alias)).resolves.toMatchObject([
        { path: repo, isMainWorktree: true }
      ])
    })
  }
)

describe('legacy primary layout controls', () => {
  it('accepts CRLF legacy field delimiters', async () => {
    await initialize()
    crlfOutput = true

    await expect(listWorktreesStrict(repo)).resolves.toMatchObject([
      { path: repo, isMainWorktree: true }
    ])
  })

  it('normalizes a separate Git directory back to the primary checkout', async () => {
    await initialize('repo', ['--separate-git-dir', join(root, 'metadata')])

    await expect(listWorktreesStrict(repo)).resolves.toMatchObject([
      { path: repo, isMainWorktree: true }
    ])
  })

  it('preserves Git primary identity when core.worktree points elsewhere', async () => {
    await initialize()
    const checkout = join(root, 'checkout')
    await mkdir(checkout)
    await git(['config', 'core.worktree', checkout])

    await expect(listWorktreesStrict(repo)).resolves.toMatchObject([
      { path: repo, isMainWorktree: true }
    ])
  })

  it('retains a bare primary without fabricating a checkout', async () => {
    await initialize('bare', ['--bare'])

    await expect(listWorktreesStrict(repo)).resolves.toEqual([
      { path: repo, head: '', branch: '', isBare: true, isMainWorktree: true }
    ])
  })
})
