import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { FILE_METHODS } from './files'
import { DIR_LISTING_PAGE_CACHE_TTL_MS, DirListingPageCache } from './files-read-dir-page'

const folder = (count: number, prefix = 'file'): DirEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${String(index).padStart(6, '0')}.txt`,
    isDirectory: false,
    isSymlink: false
  }))

const REQUEST = { worktree: 'id:wt-1', relativePath: 'big' }

describe('DirListingPageCache', () => {
  it('lists once for page one and slices that listing for later pages', async () => {
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => folder(5))

    const first = await cache.readPage('socket-1', { ...REQUEST, offset: 0, limit: 2 }, list)
    const second = await cache.readPage('socket-1', { ...REQUEST, offset: 2, limit: 2 }, list)
    const last = await cache.readPage('socket-1', { ...REQUEST, offset: 4, limit: 2 }, list)

    expect(list).toHaveBeenCalledTimes(1)
    expect([first, second, last].map((page) => page.entries.map((e) => e.name))).toEqual([
      ['file-000000.txt', 'file-000001.txt'],
      ['file-000002.txt', 'file-000003.txt'],
      ['file-000004.txt']
    ])
    expect(first.total).toBe(5)
    // The last page released the listing, so a later read lists again.
    await cache.readPage('socket-1', { ...REQUEST, offset: 2, limit: 2 }, list)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('re-lists for page one, after the time limit, and for another connection or none', async () => {
    let now = 0
    const cache = new DirListingPageCache(() => now)
    const list = vi.fn(async () => folder(5))
    await cache.readPage('socket-1', { ...REQUEST, offset: 0, limit: 2 }, list)

    await cache.readPage('socket-1', { ...REQUEST, offset: 0, limit: 2 }, list)
    await cache.readPage('socket-2', { ...REQUEST, offset: 2, limit: 2 }, list)
    await cache.readPage(undefined, { ...REQUEST, offset: 2, limit: 2 }, list)
    expect(list).toHaveBeenCalledTimes(4)

    now = DIR_LISTING_PAGE_CACHE_TTL_MS
    await cache.readPage('socket-1', { ...REQUEST, offset: 2, limit: 2 }, list)
    expect(list).toHaveBeenCalledTimes(5)
  })

  it('keys the listing by folder and symlink mode', async () => {
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => folder(5))
    await cache.readPage('socket-1', { ...REQUEST, offset: 0, limit: 2 }, list)

    await cache.readPage('socket-1', { ...REQUEST, relativePath: 'other', offset: 2 }, list)
    await cache.readPage('socket-1', { ...REQUEST, followSymlinks: true, offset: 2 }, list)
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('holds a bounded number of listings, dropping the oldest', async () => {
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => folder(3))
    for (let index = 0; index < 9; index++) {
      await cache.readPage('socket-1', { ...REQUEST, relativePath: `d${index}`, limit: 1 }, list)
    }
    expect(list).toHaveBeenCalledTimes(9)

    await cache.readPage('socket-1', { ...REQUEST, relativePath: 'd8', offset: 1, limit: 1 }, list)
    expect(list).toHaveBeenCalledTimes(9)
    await cache.readPage('socket-1', { ...REQUEST, relativePath: 'd0', offset: 1, limit: 1 }, list)
    expect(list).toHaveBeenCalledTimes(10)
  })

  it('does not hold a folder too large to keep, and re-lists it per page', async () => {
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => folder(200_001))
    await cache.readPage('socket-1', { ...REQUEST, offset: 0, limit: 10 }, list)
    await cache.readPage('socket-1', { ...REQUEST, offset: 10, limit: 10 }, list)
    expect(list).toHaveBeenCalledTimes(2)
  })
})

function dispatcherWithListing(entries: DirEntry[]) {
  const readFileExplorerDir = vi
    .fn<OrcaRuntimeService['readFileExplorerDir']>()
    .mockResolvedValue(entries)
  const runtime: Pick<OrcaRuntimeService, 'getRuntimeId' | 'readFileExplorerDir'> = {
    getRuntimeId: () => 'test-runtime',
    readFileExplorerDir
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files.readDir uses readFileExplorerDir; its response envelope reads only getRuntimeId.
    runtime: runtime as OrcaRuntimeService,
    methods: FILE_METHODS
  })
  return { dispatcher, readFileExplorerDir }
}

async function readDir(
  dispatcher: RpcDispatcher,
  params: Record<string, unknown>,
  connectionId = 'socket-1'
) {
  const replies: unknown[] = []
  await dispatcher.dispatchStreaming(
    { id: 'read', authToken: 'tok', method: 'files.readDir', params },
    (reply) => replies.push(JSON.parse(reply)),
    { clientKind: 'runtime', connectionId }
  )
  return replies[0]
}

describe('files.readDir pages', () => {
  it('pages a folder too large for one remote reply', async () => {
    const { dispatcher, readFileExplorerDir } = dispatcherWithListing(folder(80_000, 'paged'))

    const first = await readDir(dispatcher, { ...REQUEST, offset: 0, limit: 1_000 })
    const next = await readDir(dispatcher, { ...REQUEST, offset: 1_000, limit: 1_000 })

    expect(first).toMatchObject({ ok: true, result: { total: 80_000 } })
    expect(next).toMatchObject({
      ok: true,
      result: { total: 80_000, entries: expect.arrayContaining([folder(80_000, 'paged')[1_000]]) }
    })
    expect(readFileExplorerDir).toHaveBeenCalledTimes(1)
  })

  it('keeps the bare entry array when no page is asked for', async () => {
    const { dispatcher } = dispatcherWithListing(folder(3))
    expect(await readDir(dispatcher, REQUEST)).toMatchObject({
      ok: true,
      result: folder(3)
    })
  })

  it('refuses a page larger than a host serves', async () => {
    const { dispatcher } = dispatcherWithListing(folder(3))
    expect(await readDir(dispatcher, { ...REQUEST, limit: 5_001 })).toMatchObject({ ok: false })
  })
})
