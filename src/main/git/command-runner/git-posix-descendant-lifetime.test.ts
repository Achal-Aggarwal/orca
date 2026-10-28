import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git-exec-file'
import { gitStreamStdout } from './git-stream-stdout'
import { writeOwnedDescendantProcess } from '../../../packages/process-host/src/__fixtures__/owned-descendant-process'
import {
  acquireGitAdmission,
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from './git-subprocess-admission'

const execute = promisify(execFile)
const nativeSetTimeout = globalThis.setTimeout
const executionTimeoutMs = 60_000
let directory = ''
let hookPid: number | undefined

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

beforeEach(async () => {
  _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 }))
  directory = await mkdtemp(join(tmpdir(), 'orca-git-hook-lifetime-'))
  await execute('git', ['init', '-q', directory])
  await writeFile(join(directory, 'tracked.txt'), 'tracked\n')
  await execute('git', ['add', 'tracked.txt'], { cwd: directory })
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (hookPid) {
    try {
      process.kill(hookPid, 'SIGKILL')
    } catch {}
    hookPid = undefined
  }
  _resetGitAdmissionForTests()
  await rm(directory, { recursive: true, force: true })
})

async function installBlockedFsmonitor(): Promise<string> {
  const pidFile = join(directory, 'hook.pid')
  const hookScript = join(directory, 'hook.cjs')
  const executable = join(directory, 'fsmonitor')
  const node = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath
  await writeFile(
    hookScript,
    `process.on('SIGTERM', () => {});` +
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);`
  )
  await writeFile(
    executable,
    `#!/bin/sh\nexec ${quoteShellWord(node)} ${quoteShellWord(hookScript)}\n`
  )
  await chmod(executable, 0o755)
  await execute('git', ['config', 'core.fsmonitor', executable], { cwd: directory })
  return pidFile
}

async function hookIsRunning(): Promise<boolean> {
  if (!hookPid) {
    return false
  }
  const result = await execute('ps', ['-p', String(hookPid), '-o', 'stat=']).catch(() => null)
  return Boolean(result?.stdout.trim() && !result.stdout.trim().startsWith('Z'))
}

describe.skipIf(process.platform === 'win32')('POSIX Git descendant lifetime', () => {
  it.each([
    { mode: 'stream', reason: 'abort' },
    { mode: 'stream', reason: 'timeout' },
    { mode: 'capture', reason: 'abort' },
    { mode: 'capture', reason: 'timeout' }
  ])(
    'releases admission after $mode $reason stops a real fsmonitor hook',
    async ({ mode, reason }) => {
      const pidFile = await installBlockedFsmonitor()
      let expire = (): void => {
        throw new Error('Git deadline was not registered')
      }
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
        if (delay === executionTimeoutMs) {
          expire = () => callback(...args)
        }
        return nativeSetTimeout(callback, delay, ...args)
      })
      const controller = new AbortController()
      const successorController = new AbortController()
      const pending = (
        mode === 'stream'
          ? gitStreamStdout(['status', '--porcelain=v2'], {
              cwd: directory,
              signal: controller.signal,
              timeoutMs: executionTimeoutMs,
              onStdout: () => {}
            })
          : gitExecFileAsync(['status', '--porcelain=v2'], {
              cwd: directory,
              signal: controller.signal,
              timeout: executionTimeoutMs
            })
      ).catch((error: unknown) => error)
      let successor: ReturnType<typeof acquireGitAdmission> | undefined
      try {
        await expect
          .poll(() => readFile(pidFile, 'utf8').catch(() => ''), { timeout: 10_000 })
          .toMatch(/^\d+$/)
        hookPid = Number(await readFile(pidFile, 'utf8'))
        successor = acquireGitAdmission({
          args: ['status'],
          cwd: directory,
          signal: successorController.signal
        })
        void successor.catch(() => {})
        expect(_gitAdmissionSnapshotForTests().queued).toBe(1)
        if (reason === 'abort') {
          controller.abort()
        } else {
          expire()
        }
        await expect(pending).resolves.toMatchObject({
          name: reason === 'abort' ? 'AbortError' : 'GitCommandTimeoutError'
        })
        await expect.poll(hookIsRunning, { timeout: 7_000 }).toBe(false)
        await expect.poll(() => _gitAdmissionSnapshotForTests().queued, { timeout: 7_000 }).toBe(0)
        const grant = await successor
        grant.release()
        expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
      } finally {
        controller.abort()
        successorController.abort()
        await successor?.catch(() => {})
        if (hookPid) {
          try {
            process.kill(hookPid, 'SIGKILL')
          } catch {}
        }
        await pending
      }
    }
  )

  it.each(['early stop', 'parser error', 'capture limit'])(
    'cleans the Git alias descendant group after %s',
    async (mode) => {
      const fixture = await writeOwnedDescendantProcess(directory)
      const node = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath
      await execute(
        'git',
        [
          'config',
          'alias.audit-owned-group',
          `!${quoteShellWord(node)} ${quoteShellWord(fixture.script)}`
        ],
        { cwd: directory }
      )
      const pending =
        mode === 'capture limit'
          ? gitExecFileAsync(['audit-owned-group'], {
              cwd: directory,
              timeout: executionTimeoutMs,
              maxBuffer: 16
            })
          : gitStreamStdout(['audit-owned-group'], {
              cwd: directory,
              timeoutMs: executionTimeoutMs,
              onStdout: () => {
                if (mode === 'parser error') {
                  throw new Error('parser stopped')
                }
                return true
              }
            })
      try {
        await (mode === 'early stop'
          ? expect(pending).resolves.toEqual({ stoppedEarly: true })
          : expect(pending).rejects.toMatchObject(
              mode === 'parser error'
                ? { message: 'parser stopped' }
                : { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }
            ))
        await expect
          .poll(() => _gitAdmissionSnapshotForTests().budgets.general?.baseUsed, { timeout: 7_000 })
          .toBe(0)
        expect(await fixture.running()).toBe(false)
      } finally {
        await fixture.dispose()
        await pending.catch(() => {})
      }
    }
  )

  it.each(['stream', 'capture'] as const)(
    'releases ordinary successful %s admission',
    async (mode) => {
      if (mode === 'stream') {
        const result = await gitStreamStdout(['status', '--porcelain=v2'], {
          cwd: directory,
          onStdout: () => {}
        })
        expect(result).toEqual({ stoppedEarly: false })
      } else {
        const result = await gitExecFileAsync(['status', '--porcelain=v2'], { cwd: directory })
        expect(result.stderr).toBe('')
        expect(result.stdout).toContain('tracked.txt')
      }
      const successor = await acquireGitAdmission({ args: ['status'], cwd: directory })
      successor.release()
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
    }
  )
})
