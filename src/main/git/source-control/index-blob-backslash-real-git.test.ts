import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { validateGitRelativeFilePath } from '../../ipc/filesystem/filesystem-path-containment'
import { getDiff } from './file-diff'
import { readGitBlobAtIndexPath } from './git-blob-read'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function repository() {
  const repo = await mkdtemp(join(tmpdir(), 'orca-index-backslash-'))
  directories.push(repo)
  const git = async (...args: string[]) => {
    const result = await runProcess({ program: 'git', args, cwd: repo })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }
  await git('init', '-q')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  return { repo, git }
}

describe.skipIf(process.platform === 'win32')('literal POSIX index paths with real Git', () => {
  it('keeps the selected file separate from its slash-named neighbor', async () => {
    const { repo, git } = await repository()
    const filePath = 'odd\\name.txt'
    await mkdir(join(repo, 'odd'))
    await writeFile(join(repo, filePath), 'selected committed\n')
    await writeFile(join(repo, 'odd/name.txt'), 'neighbor committed\n')
    await git('add', '.')
    await git('commit', '-qm', 'base')
    await writeFile(join(repo, filePath), 'selected staged\n')
    await writeFile(join(repo, 'odd/name.txt'), 'neighbor staged\n')
    await git('add', '.')
    await writeFile(join(repo, filePath), 'selected working\n')
    await writeFile(join(repo, 'odd/name.txt'), 'neighbor working\n')
    const index = await readFile(join(repo, '.git/index'))
    const selectedPath = validateGitRelativeFilePath(repo, filePath)

    expect(await readGitBlobAtIndexPath(repo, selectedPath)).toMatchObject({
      content: 'selected staged\n',
      exists: true
    })
    expect(await getDiff(repo, selectedPath, false)).toMatchObject({
      originalContent: 'selected staged\n',
      modifiedContent: 'selected working\n'
    })
    expect(await getDiff(repo, selectedPath, true)).toMatchObject({
      modifiedContent: 'selected staged\n'
    })
    expect(await getDiff(repo, 'odd/name.txt', false)).toMatchObject({
      originalContent: 'neighbor staged\n',
      modifiedContent: 'neighbor working\n'
    })
    expect(await readFile(join(repo, '.git/index'))).toEqual(index)
    expect(await readFile(join(repo, 'odd/name.txt'), 'utf8')).toBe('neighbor working\n')
  })

  it('reads a backslash-named staged addition on an unborn branch', async () => {
    const { repo, git } = await repository()
    await writeFile(join(repo, 'new\\file.txt'), 'new staged\n')
    await git('add', '.')

    expect(await getDiff(repo, 'new\\file.txt', true)).toMatchObject({
      kind: 'text',
      originalContent: '',
      modifiedContent: 'new staged\n'
    })
  })
})
