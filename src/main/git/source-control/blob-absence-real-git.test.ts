import { chmod, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { isMissingGitBlobPath } from '../../../shared/git-blob-absence'
import { readGitBlobAtIndexPath } from './git-blob-read'
import { getDiff } from './file-diff'
import { getBranchDiff } from './branch-diff'
import { getCommitDiff } from './commit-diff'
import { buildSubmoduleInnerCommitRangeDiff } from './submodule-diff'
import { invalidateGitReadCaches, settledDiffCache } from './git-read-cache-invalidation'
import { readWorktreeDiffStamp } from './worktree-diff-stamp'

function gitInit(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' })
}

function gitCommit(dir: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: dir, stdio: 'pipe' })
}

describe('real Git missing paths and failed blob reads', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'orca-real-git-'))
    gitInit(repo)
    invalidateGitReadCaches()
  })

  afterEach(async () => {
    invalidateGitReadCaches()
    await rm(repo, { recursive: true, force: true })
  })

  async function git(args: string[], input?: string): Promise<string> {
    const result = await runProcess({ program: 'git', args, cwd: repo, input })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }

  function diff(staged = false): Promise<unknown> {
    return getDiff(repo, 'file.txt', staged)
  }

  it('does not substitute HEAD for a corrupt index blob', async () => {
    await writeFile(path.join(repo, 'file.txt'), 'committed\n')
    gitCommit(repo, 'initial')
    await writeFile(path.join(repo, 'file.txt'), 'staged\n')
    await git(['add', 'file.txt'])
    const oid = (await git(['rev-parse', ':file.txt'])).trim()
    await writeFile(path.join(repo, 'file.txt'), 'working\n')
    const old = new Date(Date.now() - 10_000)
    await Promise.all(
      ['.git/index', 'file.txt'].map((file) => utimes(path.join(repo, file), old, old))
    )
    const before = await readWorktreeDiffStamp(repo, 'file.txt', true)
    await unlink(path.join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)))
    expect(await readGitBlobAtIndexPath(repo, 'file.txt')).toMatchObject({
      exists: false,
      failed: true
    })

    await expect(diff()).rejects.toThrow('Could not read the complete diff')
    expect(settledDiffCache.stats().entries).toBe(0)
    await git(['hash-object', '-w', '--stdin'], 'staged\n')
    const after = await readWorktreeDiffStamp(repo, 'file.txt', true)
    expect(after?.value).toBe(before?.value)

    expect(await diff()).toMatchObject({
      originalContent: 'staged\n',
      modifiedContent: 'working\n'
    })
    expect(settledDiffCache.stats().entries).toBe(1)
  })

  it('retains added paths on an unborn branch', async () => {
    await writeFile(path.join(repo, 'file.txt'), 'new file\n')
    await git(['add', 'file.txt'])
    expect(await diff(true)).toMatchObject({
      originalContent: '',
      modifiedContent: 'new file\n'
    })
  })

  it('retains additions absent from a valid HEAD tree', async () => {
    await writeFile(path.join(repo, 'seed.txt'), 'seed\n')
    gitCommit(repo, 'initial')
    await writeFile(path.join(repo, 'file.txt'), 'new file\n')
    await git(['add', 'file.txt'])
    expect(await diff(true)).toMatchObject({
      originalContent: '',
      modifiedContent: 'new file\n'
    })
  })

  it.each(['staged', 'commit', 'branch', 'submodule-range'] as const)(
    'rejects corrupt %s blobs and recovers without a stale empty result',
    async (kind) => {
      await writeFile(path.join(repo, 'file.txt'), 'before\n')
      gitCommit(repo, 'initial')
      const parentOid = (await git(['rev-parse', 'HEAD'])).trim()
      await writeFile(path.join(repo, 'file.txt'), 'after\n')
      gitCommit(repo, 'changed')
      const commitOid = (await git(['rev-parse', 'HEAD'])).trim()
      const blobOid = (await git(['rev-parse', 'HEAD:file.txt'])).trim()
      await unlink(path.join(repo, '.git', 'objects', blobOid.slice(0, 2), blobOid.slice(2)))
      const load = {
        staged: () => getDiff(repo, 'file.txt', true),
        commit: () => getCommitDiff(repo, { parentOid, commitOid, filePath: 'file.txt' }),
        branch: () =>
          getBranchDiff(repo, { mergeBase: parentOid, headOid: commitOid, filePath: 'file.txt' }),
        'submodule-range': () =>
          buildSubmoduleInnerCommitRangeDiff(repo, 'file.txt', parentOid, commitOid, {})
      }
      await expect(load[kind]()).rejects.toThrow('Could not read the complete diff')

      await git(['hash-object', '-w', '--stdin'], 'after\n')
      expect(await load[kind]()).toMatchObject({
        originalContent: kind === 'staged' ? 'after\n' : 'before\n',
        modifiedContent: 'after\n'
      })
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects an unreadable working file and preserves its contents',
    async () => {
      const filePath = path.join(repo, 'file.txt')
      await writeFile(filePath, 'protected\n')
      gitCommit(repo, 'initial')
      await chmod(filePath, 0)
      try {
        await expect(diff()).rejects.toThrow('Could not read the complete diff')
      } finally {
        await chmod(filePath, 0o600)
      }
      expect(await readFile(filePath, 'utf8')).toBe('protected\n')
      expect(await diff()).toMatchObject({
        originalContent: 'protected\n',
        modifiedContent: 'protected\n'
      })
    }
  )

  it('does not mistake a missing HEAD object for an unborn branch', async () => {
    await writeFile(path.join(repo, 'file.txt'), 'protected\n')
    gitCommit(repo, 'initial')
    const commitOid = (await git(['rev-parse', 'HEAD'])).trim()
    await unlink(path.join(repo, '.git', 'objects', commitOid.slice(0, 2), commitOid.slice(2)))
    await expect(diff(true)).rejects.toThrow('Could not read the complete diff')
  })

  it('preserves known deletions and root-commit additions', async () => {
    await writeFile(path.join(repo, 'file.txt'), 'first\n')
    gitCommit(repo, 'initial')
    const commitOid = (await git(['rev-parse', 'HEAD'])).trim()
    expect(await getCommitDiff(repo, { commitOid, filePath: 'file.txt' })).toMatchObject({
      originalContent: '',
      modifiedContent: 'first\n'
    })
    await unlink(path.join(repo, 'file.txt'))
    expect(await diff()).toMatchObject({ originalContent: 'first\n', modifiedContent: '' })
    await git(['add', 'file.txt'])
    expect(await diff(true)).toMatchObject({ originalContent: 'first\n', modifiedContent: '' })
  })

  it('recognizes actual index and tree absence without accepting corrupt objects', async () => {
    await writeFile(path.join(repo, 'seed.txt'), 'seed\n')
    gitCommit(repo, 'initial')
    const names = ['file.txt', ...(process.platform === 'win32' ? [] : ["quote' and\nnewline.txt"])]
    for (const filePath of names) {
      for (const presentOnDisk of [false, true]) {
        if (presentOnDisk) {
          await writeFile(path.join(repo, filePath), 'untracked\n')
        }
        for (const oid of [undefined, 'HEAD']) {
          const result = await runProcess({
            program: 'git',
            args: ['show', '--end-of-options', `${oid ?? ''}:${filePath}`],
            cwd: repo
          })
          expect(
            isMissingGitBlobPath({ code: result.code, stderr: result.stderr }, filePath, oid)
          ).toBe(true)
        }
      }
    }
    expect(await readFile(path.join(repo, 'seed.txt'), 'utf8')).toBe('seed\n')
  })
})
