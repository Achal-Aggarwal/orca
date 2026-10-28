import { readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { readGitBlobAtIndexPath, readGitBlobAtOidPath } from './git-blob-read'
import { getCommitDiff } from './commit-diff'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'
import { getDiff } from './file-diff'
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

    expect(await diff()).toMatchObject({ originalContent: '', modifiedContent: 'working\n' })
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

  it('shows empty baselines for untracked and newly committed paths containing brackets', async () => {
    await writeFile(path.join(repo, 'seed.txt'), 'seed\n')
    gitCommit(repo, 'COMMIT_METADATA_MUST_NOT_BE_DIFF_CONTENT')
    const parentOid = (await git(['rev-parse', 'HEAD'])).trim()
    const filePath = 'new [draft].txt'
    await writeFile(path.join(repo, filePath), 'new content\n')

    expect(await readGitBlobAtIndexPath(repo, filePath)).toEqual({
      content: '',
      isBinary: false,
      exists: false,
      failed: false
    })
    expect(await readGitBlobAtOidPath(repo, 'HEAD', filePath)).toEqual({
      content: '',
      isBinary: false,
      exists: false,
      failed: false
    })
    expect(await getDiff(repo, filePath, false)).toMatchObject({
      originalContent: '',
      modifiedContent: 'new content\n'
    })

    await git(['add', '--', filePath])
    expect(await getDiff(repo, filePath, true)).toMatchObject({
      originalContent: '',
      modifiedContent: 'new content\n'
    })
    gitCommit(repo, 'add bracket path')
    const commitOid = (await git(['rev-parse', 'HEAD'])).trim()
    expect(await getCommitDiff(repo, { commitOid, parentOid, filePath })).toMatchObject({
      originalContent: '',
      modifiedContent: 'new content\n'
    })
  })

  it('keeps valid binary blob bytes and corrupt-object failures distinct from absence', async () => {
    const filePath = 'image [draft].png'
    const image = Buffer.from([0, 1, 255])
    await writeFile(path.join(repo, filePath), image)
    gitCommit(repo, 'binary bracket path')
    const expected = { content: image.toString('base64'), isBinary: true, exists: true }
    expect(await readGitBlobAtIndexPath(repo, filePath)).toEqual(expected)
    expect(await readGitBlobAtOidPath(repo, 'HEAD', filePath)).toEqual(expected)

    const oid = (await git(['rev-parse', `HEAD:${filePath}`])).trim()
    await unlink(path.join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)))
    expect(await readGitBlobAtIndexPath(repo, filePath)).toMatchObject({
      exists: false,
      failed: true
    })
    expect(await readGitBlobAtOidPath(repo, 'HEAD', filePath)).toMatchObject({
      exists: false,
      failed: true
    })
    expect(await readGitBlobAtOidPath(repo, 'missing-ref', filePath)).toMatchObject({
      exists: false,
      failed: true
    })
  })

  it('keeps oversized index and committed blob reads bounded', async () => {
    const filePath = 'large [draft].txt'
    await writeFile(path.join(repo, filePath), Buffer.alloc(MAX_GIT_SHOW_BYTES + 1, 0x61))
    gitCommit(repo, 'large blob')
    const expected = { content: '', isBinary: true, exists: true }
    expect(await readGitBlobAtIndexPath(repo, filePath)).toEqual(expected)
    expect(await readGitBlobAtOidPath(repo, 'HEAD', filePath)).toEqual(expected)
  })

  it('recognizes actual index and tree absence without accepting corrupt objects', async () => {
    await writeFile(path.join(repo, 'seed.txt'), 'seed\n')
    gitCommit(repo, 'initial')
    const names = [
      'file.txt',
      'new [draft].txt',
      ...(process.platform === 'win32'
        ? []
        : ['new *.txt', 'new ?.txt', ' edge spaces .txt ', "quote' and\nnewline.txt"])
    ]
    for (const filePath of names) {
      for (const presentOnDisk of [false, true]) {
        if (presentOnDisk) {
          await writeFile(path.join(repo, filePath), 'untracked\n')
        }
        for (const result of [
          await readGitBlobAtIndexPath(repo, filePath),
          await readGitBlobAtOidPath(repo, 'HEAD', filePath)
        ]) {
          expect(result).toEqual({ content: '', isBinary: false, exists: false, failed: false })
        }
      }
    }
    expect(await readFile(path.join(repo, 'seed.txt'), 'utf8')).toBe('seed\n')
  })
})
