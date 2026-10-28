import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { checkoutBranch, listLocalBranches } from './checkout'

let directory: string

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-branch-identity-'))
  await git('init', '-q')
  await git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await git('config', 'user.name', 'Audit')
  await git('config', 'user.email', 'audit@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('local branch picker identities', () => {
  it.each(['release', 'heads/release'])(
    'lists the exact %s branch despite a colliding tag',
    async (branch) => {
      await git('commit', '--allow-empty', '-qm', 'base')
      await git('branch', branch)
      await git('tag', branch)

      expect(await listLocalBranches(directory)).toEqual({
        current: 'main',
        branches: ['main', branch]
      })
    }
  )

  it.each(['release', 'heads/release'])(
    'keeps HEAD attached when selecting listed %s with a colliding tag',
    async (branch) => {
      await git('commit', '--allow-empty', '-qm', 'base')
      await git('branch', branch)
      const branchOid = await git('rev-parse', `refs/heads/${branch}`)
      await git('commit', '--allow-empty', '-qm', 'tag target')
      await git('tag', branch)
      const listing = await listLocalBranches(directory)
      const selected = listing.branches.find((name) => name !== listing.current)
      expect(selected).toBeDefined()

      await checkoutBranch(directory, selected ?? '')

      expect(await git('symbolic-ref', '--quiet', 'HEAD')).toBe(`refs/heads/${branch}`)
      expect(await git('rev-parse', 'HEAD')).toBe(branchOid)
      expect(await listLocalBranches(directory)).toEqual({
        current: branch,
        branches: [branch, 'main']
      })
    }
  )

  it('lists ordinary local branches with the current branch first', async () => {
    await git('commit', '--allow-empty', '-qm', 'base')
    await git('branch', 'feature')
    await checkoutBranch(directory, 'feature')

    expect(await listLocalBranches(directory)).toEqual({
      current: 'feature',
      branches: ['feature', 'main']
    })
  })

  it('preserves detached and unborn listing behavior', async () => {
    expect(await listLocalBranches(directory)).toEqual({ current: null, branches: [] })
    await git('commit', '--allow-empty', '-qm', 'base')
    await git('tag', 'main')
    await git('checkout', '--detach', '-q')

    expect(await listLocalBranches(directory)).toEqual({ current: null, branches: ['main'] })
  })
})

installRealWorkerThreadChildProcesses()
