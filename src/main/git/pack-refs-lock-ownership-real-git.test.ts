import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import { beforeAll, describe, expect, it } from 'vitest'
import { PackRefsLockOwnership } from './pack-refs-lock-ownership'

const deadPid = 0x7fffffff
let supportsPreparedTransactions = false

beforeAll(async () => {
  const result = await runProcess({ program: 'git', args: ['--version'] })
  expect(result.code, result.stderr).toBe(0)
  const version = result.stdout.match(/git version (\d+)\.(\d+)/)
  supportsPreparedTransactions =
    version !== null &&
    (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 29))
})

async function git(directory: string, ...args: string[]) {
  return runProcess({ program: 'git', args, cwd: directory, timeoutMs: 3_000 })
}

async function createRepo(directory: string): Promise<{ head: string; target: string }> {
  const commands = [
    ['init', '-q'],
    ['symbolic-ref', 'HEAD', 'refs/heads/main'],
    ['config', 'user.name', 'Audit'],
    ['config', 'user.email', 'audit@example.test'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.hooksPath', ''],
    ['commit', '--allow-empty', '-qm', 'first'],
    ['commit', '--allow-empty', '-qm', 'second'],
    ['branch', 'topic', 'HEAD']
  ]
  for (const args of commands) {
    const result = await git(directory, ...args)
    expect(result.code, result.stderr).toBe(0)
  }
  return {
    head: (await git(directory, 'rev-parse', 'HEAD')).stdout.trim(),
    target: (await git(directory, 'rev-parse', 'HEAD^')).stdout.trim()
  }
}

function prepareTransaction(directory: string, command: string) {
  const child = spawnProcess({ program: 'git', args: ['update-ref', '--stdin'], cwd: directory })
  let output = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve))
  const prepared = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Git transaction did not prepare')), 3_000)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      reject(error)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('prepare: ok')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('error', fail)
    child.stdin.once('error', fail)
    child.once('exit', () => {
      if (!output.includes('prepare: ok')) {
        fail(new Error(`Git transaction did not prepare: ${stderr}`))
      }
    })
  })
  child.stdin.write(`start\n${command}\nprepare\n`)
  return { child, prepared, closed }
}

describe('foreign Git ref transaction locks', () => {
  it.for([
    { operation: 'verify', aged: false },
    { operation: 'verify', aged: true },
    { operation: 'update', aged: false }
  ])(
    'preserves a $operation transaction lock (aged=$aged)',
    async ({ operation, aged }, context) => {
      if (!supportsPreparedTransactions) {
        context.skip()
      }
      const directory = await mkdtemp(join(tmpdir(), 'orca-foreign-ref-lock-'))
      let transaction: ReturnType<typeof prepareTransaction> | undefined
      try {
        const { head, target } = await createRepo(directory)
        const commonDir = join(directory, '.git')
        const marker = join(commonDir, 'packed-refs.orca-owner')
        const lock = join(commonDir, 'refs', 'heads', 'topic.lock')
        await writeFile(marker, JSON.stringify({ pid: deadPid }))
        const old = new Date(0)
        await utimes(marker, old, old)
        const command =
          operation === 'verify'
            ? `verify refs/heads/topic ${head}`
            : `update refs/heads/topic ${target} ${head}`
        transaction = prepareTransaction(directory, command)
        await transaction.prepared
        expect(transaction.child.exitCode).toBeNull()
        const before = await stat(lock)
        if (operation === 'verify') {
          expect(before.size).toBe(0)
        } else {
          expect(before.size).toBeGreaterThan(0)
        }
        if (aged) {
          await utimes(lock, old, old)
        }
        await expect(new PackRefsLockOwnership(commonDir).claim()).resolves.toEqual({ ok: true })

        const competing = await git(directory, 'update-ref', 'refs/heads/topic', target, head)
        expect(competing.code).not.toBe(0)
        expect(competing.stderr).toContain('cannot lock ref')
        expect((await stat(lock)).ino).toBe(before.ino)

        transaction.child.stdin.end('commit\n')
        expect(await transaction.closed).toBe(0)
        const expected = operation === 'verify' ? head : target
        expect((await git(directory, 'rev-parse', 'refs/heads/topic')).stdout.trim()).toBe(expected)
        expect((await git(directory, 'update-ref', 'refs/heads/topic', head, expected)).code).toBe(
          0
        )
      } finally {
        transaction?.child.kill('SIGKILL')
        await transaction?.closed
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})
