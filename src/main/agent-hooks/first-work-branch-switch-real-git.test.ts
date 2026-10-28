import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'
import {
  makeBranchRenameDeps,
  REPO_ID,
  workingEvent
} from './first-work-branch-rename-test-harness'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: execMock }))
vi.mock('../git/git-username', () => ({ resolveLocalGitUsername: async () => 'audit' }))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateBranchNameFromContext: async () => ({ success: true, slug: 'fix-auth' }),
  resolveTextGenerationParams: () => ({ ok: true, params: { agentId: 'claude', model: 'm' } })
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: async () => ({ ok: true })
}))
vi.mock('../ipc/worktree-branch-name', () => ({
  computeBranchName: (leaf: string) => `audit/${leaf}`,
  getConfiguredBranchPrefix: () => 'audit'
}))

import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from './first-work-branch-rename'

let directory: string
const initialBranch = 'audit/Nautilus'
const manualBranch = 'user-choice'
const generatedBranch = 'audit/fix-auth'

async function git(...args: string[]) {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr), { code: result.code, stderr: result.stderr })
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

beforeEach(async () => {
  resetFirstWorkBranchRenameState()
  execMock.mockReset()
  directory = await mkdtemp(join(tmpdir(), 'orca-auto-rename-'))
  await git('init', '-q')
  await git('symbolic-ref', 'HEAD', `refs/heads/${initialBranch}`)
  await git('config', 'user.name', 'Audit')
  await git('config', 'user.email', 'audit@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(directory, 'file.txt'), 'retained\n')
  await git('add', '.')
  await git('commit', '-qm', 'base')
  await git('branch', manualBranch)
})

afterEach(async () => {
  resetFirstWorkBranchRenameState()
  await rm(directory, { recursive: true, force: true })
})

function makeLocalRenameDeps() {
  const worktreeId = `${REPO_ID}${WORKTREE_ID_SEPARATOR}${directory}`
  return makeBranchRenameDeps(vi.fn, {
    getRepo: () => ({
      id: REPO_ID,
      path: directory,
      displayName: 'repo',
      badgeColor: '',
      addedAt: 0
    }),
    resolveWorktreeIdForTab: () => worktreeId
  })
}

describe('first-work auto-rename branch ownership', () => {
  it.each(['normal', 'source-tag', 'destination-tag', 'heads-prefix-tag'] as const)(
    'renames the observed branch with %s identity when checkout remains unchanged',
    async (identity) => {
      let sourceBranch = initialBranch
      if (identity === 'heads-prefix-tag') {
        sourceBranch = `heads/${initialBranch}`
        await git('branch', '-m', sourceBranch)
      }
      if (identity !== 'normal') {
        await git('tag', identity === 'destination-tag' ? generatedBranch : sourceBranch)
      }
      execMock.mockImplementation((args: string[]) => git(...args))
      const { deps, onRenamed, setDisplayName, renameWorktreeFolder } = makeLocalRenameDeps()

      await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

      expect((await git('symbolic-ref', 'HEAD')).stdout.trim()).toBe(
        `refs/heads/${generatedBranch}`
      )
      await expect(git('show-ref', '--verify', `refs/heads/${sourceBranch}`)).rejects.toThrow()
      expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
      expect(setDisplayName).toHaveBeenCalledWith(
        `${REPO_ID}${WORKTREE_ID_SEPARATOR}${directory}`,
        'Fix auth'
      )
      expect(renameWorktreeFolder).toHaveBeenCalledOnce()
    }
  )

  it('leaves detached HEAD and its branch untouched', async () => {
    await git('checkout', '--detach', '-q')
    execMock.mockImplementation((args: string[]) => git(...args))
    const { deps, onRenamed, setDisplayName, renameWorktreeFolder } = makeLocalRenameDeps()

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    await expect(git('symbolic-ref', 'HEAD')).rejects.toThrow()
    await expect(git('show-ref', '--verify', `refs/heads/${initialBranch}`)).resolves.toBeDefined()
    await expect(git('show-ref', '--verify', `refs/heads/${generatedBranch}`)).rejects.toThrow()
    expect(onRenamed).not.toHaveBeenCalled()
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(renameWorktreeFolder).not.toHaveBeenCalled()
  })

  it.each(['lookup', 'mutation'] as const)(
    'preserves a user branch selected during the %s boundary',
    async (boundary) => {
      let switched = false
      execMock.mockImplementation(async (args: string[]) => {
        const atBoundary =
          boundary === 'lookup' ? args[0] === 'show-ref' : args[0] === 'branch' && args[1] === '-m'
        if (atBoundary && !switched) {
          switched = true
          await git('checkout', '-q', manualBranch)
        }
        return git(...args)
      })
      const { deps, onRenamed, setDisplayName, renameWorktreeFolder } = makeLocalRenameDeps()
      await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

      expect(switched).toBe(true)
      expect((await git('symbolic-ref', '--short', 'HEAD')).stdout.trim()).toBe(manualBranch)
      await expect(git('show-ref', '--verify', `refs/heads/${manualBranch}`)).resolves.toBeDefined()
      expect(onRenamed).not.toHaveBeenCalled()
      expect(setDisplayName).not.toHaveBeenCalled()
      expect(renameWorktreeFolder).not.toHaveBeenCalled()
      if (boundary === 'lookup') {
        await expect(
          git('show-ref', '--verify', `refs/heads/${initialBranch}`)
        ).resolves.toBeDefined()
        await expect(git('show-ref', '--verify', `refs/heads/${generatedBranch}`)).rejects.toThrow()
      } else {
        await expect(git('show-ref', '--verify', `refs/heads/${initialBranch}`)).rejects.toThrow()
        await expect(
          git('show-ref', '--verify', `refs/heads/${generatedBranch}`)
        ).resolves.toBeDefined()
      }
    }
  )
})
