import { lutimes, mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { getDiff } from './file-diff'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-symlink-diff-'))
  directories.push(directory)
  const repo = join(directory, 'repo')
  await mkdir(repo)
  const git = async (...args: string[]) => {
    const result = await runProcess({ program: 'git', args, cwd: repo })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  await git('init', '-q')
  await git('config', 'user.name', 'Audit')
  await git('config', 'user.email', 'audit@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  const first = join(directory, 'first.txt')
  await writeFile(first, 'first target bytes\n')
  return { directory, repo, git, first, link: join(repo, 'link.txt') }
}

describe.skipIf(process.platform === 'win32')('working symlink diffs with real Git', () => {
  it.each(['file', 'directory', 'missing'])(
    'compares link target names for a link to a $0',
    async (kind) => {
      const { directory, repo, git, first, link } = await repository()
      await symlink(first, link)
      await git('add', '--', 'link.txt')
      await git('commit', '-qm', 'tracked link')
      expect(await git('show', ':link.txt')).toBe(first)
      const second = join(directory, `second-${kind}`)
      if (kind === 'file') {
        await writeFile(second, 'second target bytes must not be diff content\n')
      } else if (kind === 'directory') {
        await mkdir(second)
      }
      await unlink(link)
      await symlink(second, link)

      const diff = await getDiff(repo, 'link.txt', false, false, { readSymbolicLinkTargets: true })

      expect(diff).toMatchObject({
        kind: 'text',
        originalContent: first,
        modifiedContent: second,
        symbolicLink: true
      })
    }
  )

  it('keeps concurrent legacy target-byte reads separate from target-name reads', async () => {
    const { repo, git, first, link } = await repository()
    await symlink(first, link)
    await git('add', '--', 'link.txt')
    await git('commit', '-qm', 'tracked link')
    const old = new Date('2000-01-01T00:00:00Z')
    await Promise.all([
      utimes(join(repo, '.git', 'index'), old, old),
      utimes(first, old, old),
      lutimes(link, old, old)
    ])

    const [legacy, targetName] = await Promise.all([
      getDiff(repo, 'link.txt', false),
      getDiff(repo, 'link.txt', false, false, { readSymbolicLinkTargets: true })
    ])
    expect(legacy).toMatchObject({ kind: 'text', modifiedContent: 'first target bytes\n' })
    expect(legacy.symbolicLink).toBeUndefined()
    expect(targetName).toMatchObject({ kind: 'text', modifiedContent: first, symbolicLink: true })

    await writeFile(first, 'changed target bytes\n')
    expect(await getDiff(repo, 'link.txt', false)).toMatchObject({
      modifiedContent: 'changed target bytes\n'
    })
    expect(
      await getDiff(repo, 'link.txt', false, false, { readSymbolicLinkTargets: true })
    ).toMatchObject({ modifiedContent: first, symbolicLink: true })
  })

  it('reclassifies regular-to-link and link-to-regular replacements', async () => {
    const { repo, git, first, link } = await repository()
    await writeFile(link, 'original\n')
    await git('add', '--', 'link.txt')
    await git('commit', '-qm', 'tracked file')
    const read = () => getDiff(repo, 'link.txt', false, false, { readSymbolicLinkTargets: true })
    expect((await read()).symbolicLink).toBeUndefined()

    await unlink(link)
    await symlink(first, link)
    expect(await read()).toMatchObject({
      originalContent: 'original\n',
      modifiedContent: first,
      symbolicLink: true
    })

    await unlink(link)
    await writeFile(link, 'regular again\n')
    const regular = await read()
    expect(regular).toMatchObject({
      originalContent: 'original\n',
      modifiedContent: 'regular again\n'
    })
    expect(regular.symbolicLink).toBeUndefined()
  })

  it('retains honest binary classification when an image becomes a link', async () => {
    const { repo, git, first } = await repository()
    const image = join(repo, 'image.png')
    await writeFile(image, Buffer.from([137, 80, 78, 71, 0, 1]))
    await git('add', '--', 'image.png')
    await git('commit', '-qm', 'tracked binary')
    await unlink(image)
    await symlink(first, image)

    expect(
      await getDiff(repo, 'image.png', false, false, { readSymbolicLinkTargets: true })
    ).toMatchObject({
      kind: 'binary',
      isImage: false,
      originalIsBinary: true,
      modifiedIsBinary: false,
      modifiedContent: first,
      symbolicLink: true
    })
  })

  it('keeps staged link target names independent of target file contents', async () => {
    const { directory, repo, git, first, link } = await repository()
    await symlink(first, link)
    await git('add', '--', 'link.txt')
    await git('commit', '-qm', 'tracked link')
    const second = join(directory, 'second.txt')
    await writeFile(second, 'second target bytes\n')
    await unlink(link)
    await symlink(second, link)
    await git('add', '--', 'link.txt')

    expect(await getDiff(repo, 'link.txt', true)).toMatchObject({
      kind: 'text',
      originalContent: first,
      modifiedContent: second
    })
  })

  it('keeps ordinary working file contents', async () => {
    const { repo, git, link } = await repository()
    await writeFile(link, 'original\n')
    await git('add', '--', 'link.txt')
    await git('commit', '-qm', 'tracked file')
    await writeFile(link, 'modified\n')

    expect(
      await getDiff(repo, 'link.txt', false, false, { readSymbolicLinkTargets: true })
    ).toMatchObject({
      kind: 'text',
      originalContent: 'original\n',
      modifiedContent: 'modified\n'
    })
  })
})

installRealWorkerThreadChildProcesses()
