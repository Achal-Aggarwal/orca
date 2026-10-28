import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'
import { readWorkingTreeFile } from './git-blob-read'

const mutation = vi.hoisted(() => ({ path: '', bytes: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const stats = await actual.stat(...args)
      if (args[0] === mutation.path) {
        mutation.path = ''
        await actual.writeFile(args[0], Buffer.alloc(mutation.bytes, 'x'))
      }
      return stats
    }
  }
})

describe('working-tree blob read limit during concurrent writes', () => {
  const directories: string[] = []

  afterEach(async () => {
    mutation.path = ''
    mutation.bytes = 0
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function growingFile(bytes: number): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'orca-growing-diff-'))
    directories.push(directory)
    const filePath = path.join(directory, 'growing.txt')
    await writeFile(filePath, 'initial\n')
    mutation.path = filePath
    mutation.bytes = bytes
    return filePath
  }

  it('omits a body that grows beyond the limit after the path size check', async () => {
    const filePath = await growingFile(MAX_GIT_SHOW_BYTES + 1)

    const result = await readWorkingTreeFile(filePath)
    expect(result.isBinary).toBe(true)
    expect(result.content.length).toBe(0)
    expect(result.exists).toBe(true)
    expect(mutation.path).toBe('')
  })

  it('keeps the complete new contents when growth stays within the limit', async () => {
    const filePath = await growingFile(64 * 1024)

    expect(await readWorkingTreeFile(filePath)).toEqual({
      content: 'x'.repeat(64 * 1024),
      isBinary: false,
      exists: true
    })
  })
})
