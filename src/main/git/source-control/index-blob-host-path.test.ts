import { describe, expect, it, vi } from 'vitest'
import type * as NodePath from 'node:path'

const host = vi.hoisted(() => ({ separator: '/', execute: vi.fn() }))

vi.mock('node:path', async (importOriginal) => {
  const original = await importOriginal<typeof NodePath>()
  return {
    ...original,
    get sep() {
      return host.separator
    }
  }
})
vi.mock('../runner', () => ({ gitExecFileAsyncBuffer: host.execute }))

import { readGitBlobAtIndexPath } from './git-blob-read'

describe('index blob execution-host paths', () => {
  it.each([
    { separator: '/', worktree: '/repo', options: {}, expected: ':src\\file.txt' },
    { separator: '\\', worktree: 'C:\\repo', options: {}, expected: ':src/file.txt' },
    {
      separator: '\\',
      worktree: 'C:\\repo',
      options: { wslDistro: 'Ubuntu' },
      expected: ':src/file.txt'
    }
  ])('reads $expected on host separator $separator', async (testCase) => {
    host.separator = testCase.separator
    host.execute.mockResolvedValue({ stdout: Buffer.from('selected\n') })

    expect(
      await readGitBlobAtIndexPath(testCase.worktree, 'src\\file.txt', testCase.options)
    ).toMatchObject({ content: 'selected\n', exists: true })
    expect(host.execute).toHaveBeenLastCalledWith(
      ['show', testCase.expected],
      expect.objectContaining({ cwd: testCase.worktree, ...testCase.options })
    )
  })
})
