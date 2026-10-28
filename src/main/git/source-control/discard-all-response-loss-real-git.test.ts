import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import {
  runDiscardAllForArea,
  type DiscardAllArea
} from '../../../shared/source-control-discard-all-sequence'
import { bulkDiscardChanges, discardChanges } from './discard-changes'

let repository: string
const selected = 'change[1].txt'
const sibling = 'change1.txt'

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: repository })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), 'orca-discard-response-'))
  await git('init', '-q')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(repository, 'anchor.txt'), 'anchor\n')
  await git('add', '.')
  await git('commit', '-qm', 'initial')
})

afterEach(async () => {
  await rm(repository, { recursive: true, force: true })
})

async function prepareChange(tracked: boolean): Promise<void> {
  if (tracked) {
    await writeFile(join(repository, selected), 'committed\n')
    await git('add', '--', `:(literal)${selected}`)
    await git('commit', '-qm', 'tracked file')
  }
  await writeFile(join(repository, selected), 'confirmed discard\n')
  await writeFile(join(repository, sibling), 'untouched sibling\n')
}

async function discardWithHostReply(
  area: DiscardAllArea,
  afterBulk: () => Promise<void>,
  unsupported = false
) {
  const errors: unknown[] = []
  const discardOne = vi.fn((path: string) => discardChanges(repository, path))
  const result = await runDiscardAllForArea(area, [selected], {
    bulkUnstage: async () => {
      throw new Error('Unexpected unstage')
    },
    discardMany: async (paths) => {
      if (unsupported) {
        throw Object.assign(new Error('Unknown method: git.bulkDiscard'), {
          code: 'method_not_found'
        })
      }
      await bulkDiscardChanges(repository, paths)
      await afterBulk()
    },
    discardOne,
    onError: (error) => errors.push(error)
  })
  return { result, errors, discardOne }
}

const cases = [
  { tracked: true, reply: 'timeout' },
  { tracked: false, reply: 'timeout' },
  { tracked: true, reply: 'disconnect' },
  { tracked: false, reply: 'disconnect' }
] as const

describe('bulk discard response loss', () => {
  it.each(cases)(
    'preserves a new edit after $reply, tracked=$tracked',
    async ({ tracked, reply }) => {
      await prepareChange(tracked)
      const { result, errors, discardOne } = await discardWithHostReply(
        tracked ? 'unstaged' : 'untracked',
        async () => {
          if (tracked) {
            expect(await readFile(join(repository, selected), 'utf8')).toBe('committed\n')
          } else {
            await expect(readFile(join(repository, selected), 'utf8')).rejects.toMatchObject({
              code: 'ENOENT'
            })
          }
          await writeFile(join(repository, selected), 'new unconfirmed edit\n')
          if (reply === 'disconnect') {
            throw new Error('Connection closed before the discard response arrived')
          }
          throw Object.assign(new Error('Discard response timed out'), { code: 'runtime_timeout' })
        }
      )

      expect(await readFile(join(repository, selected), 'utf8')).toBe('new unconfirmed edit\n')
      expect(await readFile(join(repository, sibling), 'utf8')).toBe('untouched sibling\n')
      expect(discardOne).not.toHaveBeenCalled()
      expect(result).toEqual({ discarded: [], failed: [selected], aborted: false })
      expect(errors).toHaveLength(1)
    }
  )

  it.each([true, false])('retains older-host fallback, tracked=%s', async (tracked) => {
    await prepareChange(tracked)
    const { result, errors, discardOne } = await discardWithHostReply(
      tracked ? 'unstaged' : 'untracked',
      async () => {
        throw new Error('Unsupported host must not execute bulk discard')
      },
      true
    )

    if (tracked) {
      expect(await readFile(join(repository, selected), 'utf8')).toBe('committed\n')
    } else {
      await expect(readFile(join(repository, selected), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
    expect(await readFile(join(repository, sibling), 'utf8')).toBe('untouched sibling\n')
    expect(discardOne).toHaveBeenCalledOnce()
    expect(result).toEqual({ discarded: [selected], failed: [], aborted: false })
    expect(errors).toEqual([])
  })
})

installRealWorkerThreadChildProcesses()
