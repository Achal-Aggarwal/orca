import { beforeEach, expect, it, vi } from 'vitest'
import type * as NodePath from 'node:path'
import { getRemoteFileUrl } from './repo'
import { getRemoteFileTarget } from './repo-remote-file-target'

vi.mock('node:path', async (importActual) => ({
  ...(await importActual<typeof NodePath>()),
  sep: '\\'
}))
vi.mock('./repo-remote-file-target', () => ({ getRemoteFileTarget: vi.fn() }))

beforeEach(() => {
  vi.mocked(getRemoteFileTarget).mockReset().mockResolvedValue({
    remoteUrl: 'https://github.com/org/repo.git',
    ref: 'published-ref'
  })
})

it.each([
  { root: String.raw`C:\repo`, options: {} },
  { root: String.raw`\\wsl.localhost\Ubuntu\home\repo`, options: {} },
  { root: String.raw`C:\repo`, options: { wslDistro: 'Ubuntu' } }
])(
  'normalizes native Windows path separators at the owning repo boundary for $root',
  async ({ root, options }) => {
    await expect(getRemoteFileUrl(root, String.raw`src\a file.ts`, 7, 10, options)).resolves.toBe(
      'https://github.com/org/repo/blob/published-ref/src/a%20file.ts#L7-L10'
    )
    expect(getRemoteFileTarget).toHaveBeenCalledWith(root, options)
  }
)

it('accepts already canonical Git paths on Windows', async () => {
  await expect(getRemoteFileUrl(String.raw`C:\repo`, 'src/a file.ts', 7)).resolves.toBe(
    'https://github.com/org/repo/blob/published-ref/src/a%20file.ts#L7'
  )
})
