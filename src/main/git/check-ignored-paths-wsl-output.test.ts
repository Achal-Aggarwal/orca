import { EventEmitter } from 'node:events'
import type * as ChildProcess from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
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

import { checkIgnoredPaths } from './check-ignored-paths'
import { findKnownHugeFolderPathsToIgnore } from './huge-folder-ignore'
import { resolveWorktreeSharedDirectories } from './worktree-shared-directories'
import { resolveWorktreeIncludePaths } from './worktree-include-file'
import { gitExecFileAsync } from './runner'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

const nativePlatform = process.platform
const banner = 'To run a command as administrator, use sudo.\n\n'
let repository: string
let gitBinary: string
let version: string
let indexBefore: Buffer

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: gitBinary, args, cwd: repository })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

describe.skipIf(nativePlatform === 'win32')(
  'ignored paths through real WSL fallback scripts',
  () => {
    beforeAll(async () => {
      const resolved = await runProcess({
        program: '/bin/sh',
        args: ['-c', 'command -v git']
      })
      gitBinary = process.env.ORCA_GIT_COMPAT_BINARY ?? resolved.stdout.trim()
      expect(isAbsolute(gitBinary)).toBe(true)
      repository = await mkdtemp(join(tmpdir(), 'orca-wsl-ignore-'))
      version = (await git('--version')).trim()
      if (process.env.ORCA_GIT_COMPAT_VERSION) {
        expect(version).toBe(`git version ${process.env.ORCA_GIT_COMPAT_VERSION}`)
      }
      await git('init', '-q')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.test')
      await git('config', 'commit.gpgsign', 'false')
      await git('config', 'core.hooksPath', '')
      await mkdir(join(repository, 'node_modules'))
      await mkdir(join(repository, 'dist'))
      await writeFile(join(repository, '.env'), 'private fixture bytes\n')
      await writeFile(join(repository, 'visible.txt'), 'visible\n')
      await writeFile(join(repository, '.gitignore'), 'node_modules/\ndist/\n.env\n')
      await writeFile(
        join(repository, 'orca.yaml'),
        'worktree:\n  sharedDirectories:\n    - node_modules\n    - dist\n'
      )
      await writeFile(join(repository, '.worktreeinclude'), '.env\nnode_modules\n')
      await git('add', '.gitignore', 'orca.yaml', '.worktreeinclude', 'visible.txt')
      await git('commit', '-qm', 'fixture')
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
      expect(await readFile(join(repository, '.gitignore'), 'utf8')).toBe(
        'node_modules/\ndist/\n.env\n'
      )
      expect(await readFile(join(repository, '.env'), 'utf8')).toBe('private fixture bytes\n')
    })

    it.each(['native', 'clean', 'banner'] as const)(
      'preserves exact ignore membership and workspace consumers, mode=%s',
      async (mode) => {
        const inputs: unknown[][] = []
        const exitCodes: (number | string)[] = []
        let rejectedProbes = 0
        execFileMock.mockImplementation(
          (nativeExec: typeof ChildProcess.execFile, command, args, execOptions, callback) => {
            if (command !== 'wsl.exe') {
              expect(command).toBe('git')
              return nativeExec(gitBinary, args, execOptions, callback)
            }
            const script = String(args.at(-1))
            if (script.includes('_orca_git_path=')) {
              rejectedProbes += 1
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
            expect(args).toContain('--exec')
            const nestedGit = quotePosixShell(quotePosixShell('git')).slice(1, -1)
            const nestedBinary = quotePosixShell(quotePosixShell(gitBinary)).slice(1, -1)
            const routed = script.replaceAll(nestedGit, nestedBinary)
            expect(routed).not.toBe(script)
            const prefix = mode === 'banner' ? `printf %s ${quotePosixShell(banner)}; ` : ''
            const child = nativeExec(
              '/bin/sh',
              ['-c', prefix + routed],
              { ...execOptions, cwd: repository },
              (error, stdout, stderr) => {
                if (script.includes('check-ignore')) {
                  exitCodes.push(error?.code ?? 0)
                }
                callback(error, stdout, stderr)
              }
            )
            if (script.includes('check-ignore')) {
              if (!child.stdin) {
                throw new Error('check-ignore requires piped stdin')
              }
              const end = vi.spyOn(child.stdin, 'end')
              inputs.push(end.mock.calls)
            }
            return child
          }
        )
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: mode === 'native' ? nativePlatform : 'win32'
        })
        const options = mode === 'native' ? {} : { wslDistro: 'Ubuntu' }
        const executed = await gitExecFileAsync(['--version'], {
          cwd: repository,
          ...options,
          captureWslLoginShellOutput: true
        })
        expect(executed.stdout.trim()).toBe(version)
        expect(
          await checkIgnoredPaths(
            repository,
            ['node_modules', 'dist', '.env', 'visible.txt'],
            options
          )
        ).toEqual(['node_modules', 'dist', '.env'])
        expect(await checkIgnoredPaths(repository, ['visible.txt'], options)).toEqual([])
        expect(await findKnownHugeFolderPathsToIgnore(repository, options)).toEqual([])
        expect(await resolveWorktreeSharedDirectories(repository, options)).toEqual([
          'dist',
          'node_modules'
        ])
        expect(await resolveWorktreeIncludePaths(repository, options)).toEqual([
          '.env',
          'node_modules'
        ])
        if (mode !== 'native') {
          expect(rejectedProbes).toBe(1)
          expect(exitCodes).toEqual([0, 1, 0, 0, 0])
          expect(inputs).toEqual([
            [['node_modules\0dist\0.env\0visible.txt\0']],
            [['visible.txt\0']],
            [['node_modules\0dist\0']],
            [['node_modules\0dist\0']],
            [['.env\0node_modules\0']]
          ])
        }
      }
    )
  }
)
