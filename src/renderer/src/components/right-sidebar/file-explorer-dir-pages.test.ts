import type { SetStateAction } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'

const readRuntimeDirectoryPage = vi.fn()
vi.mock('@/runtime/runtime-directory-page-client', () => ({
  readRuntimeDirectoryPage: (...args: unknown[]) => readRuntimeDirectoryPage(...args)
}))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({ kind: 'local' }),
  getFileExplorerOperationRoute: () => ({ target: { kind: 'local' }, connectionId: null }),
  getFileExplorerOwnerUnresolvedMessage: () => 'unresolved'
}))

import {
  FILE_EXPLORER_DIR_PAGE_ENTRIES,
  readFileExplorerDirectory
} from './file-explorer-directory-listing'
import {
  appendFileExplorerDirPage,
  fileExplorerRevealDirToReadOn,
  loadMoreFileExplorerDir
} from './file-explorer-dir-pages'
import { fileExplorerDirsDueForMore } from './use-file-explorer-load-more'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import type { DirCache } from './file-explorer-types'

const file = (name: string): DirEntry => ({ name, isDirectory: false, isSymlink: false })
const names = (count: number, from = 0): DirEntry[] =>
  Array.from({ length: count }, (_, index) => file(`f${String(from + index).padStart(5, '0')}`))

/** A host folder of `total` sorted files, served page by page. */
function serveFolder(total: number): void {
  readRuntimeDirectoryPage.mockImplementation(
    async (_context, _dirPath, page: { offset: number; limit: number }) => ({
      entries: names(Math.max(0, Math.min(page.limit, total - page.offset)), page.offset),
      total
    })
  )
}

beforeEach(() => {
  readRuntimeDirectoryPage.mockReset()
})

describe('paged folder listing', () => {
  it('lists the first page of a big folder and remembers where the rest starts', async () => {
    serveFolder(2_500)
    const listing = await readFileExplorerDirectory('wt-1', '/w', '/w')
    expect(listing.entries).toHaveLength(FILE_EXPLORER_DIR_PAGE_ENTRIES)
    expect(listing.more).toEqual({ nextOffset: 1_000, total: 2_500 })
  })

  it('re-reads as many rows as were shown on a refresh, then reports the folder complete', async () => {
    serveFolder(2_500)
    const listing = await readFileExplorerDirectory('wt-1', '/w', '/w', { minEntries: 2_000 })
    expect(listing.entries).toHaveLength(2_000)
    expect(listing.more).toEqual({ nextOffset: 2_000, total: 2_500 })

    const whole = await readFileExplorerDirectory('wt-1', '/w', '/w', { minEntries: 2_400 })
    expect(whole.entries).toHaveLength(2_500)
    expect(whole.more).toBeUndefined()
  })

  it('reports no more rows for a folder the host sent whole', async () => {
    readRuntimeDirectoryPage.mockResolvedValueOnce({ entries: names(3), total: 3 })
    expect((await readFileExplorerDirectory('wt-1', '/w', '/w')).more).toBeUndefined()
  })

  it('appends a page in order, keeping a row the watcher already added once', () => {
    const owner = { kind: 'local' as const }
    const cache: DirCache = {
      children: [
        { name: 'f00000', path: '/w/f00000', relativePath: 'f00000', isDirectory: false, depth: 0 },
        { name: 'f00003', path: '/w/f00003', relativePath: 'f00003', isDirectory: false, depth: 0 }
      ],
      operationOwner: owner,
      more: { nextOffset: 1, total: 4 }
    }
    const appended = appendFileExplorerDirPage(
      cache,
      { entries: names(3, 1), operationOwner: owner },
      '/w',
      -1,
      '/w'
    )
    expect(appended.children.map((child) => child.name)).toEqual([
      'f00000',
      'f00001',
      'f00002',
      'f00003'
    ])
    expect(appended.more).toBeUndefined()
  })

  it('does not extend rows with a page from another host', () => {
    const cache: DirCache = {
      children: [],
      operationOwner: { kind: 'local' },
      more: { nextOffset: 0, total: 1 }
    }
    const appended = appendFileExplorerDirPage(
      cache,
      { entries: names(1), operationOwner: { kind: 'ssh', connectionId: 'c' } },
      '/w',
      -1,
      '/w'
    )
    expect(appended).toEqual({ children: [], operationOwner: { kind: 'local' } })
  })
})

describe('loading more on scroll', () => {
  const partial = (lastPath: string): DirCache => ({
    children: [
      { name: 'last', path: lastPath, relativePath: 'last', isDirectory: false, depth: 0 }
    ],
    more: { nextOffset: 1, total: 9 }
  })
  const projection = (indexes: Record<string, number>) => ({
    getIndexByPath: (path: string) => indexes[path] ?? null
  })

  it('picks folders whose last row is near the rendered rows, not hidden, loading or failed', () => {
    const dirCache: Record<string, DirCache> = {
      '/w/near': partial('/w/near/last'),
      '/w/far': partial('/w/far/last'),
      '/w/collapsed': partial('/w/collapsed/last'),
      '/w/loading': partial('/w/loading/last'),
      '/w/failed': { ...partial('/w/failed/last'), error: 'gone' },
      '/w/done': { children: partial('/w/done/last').children }
    }
    const indexes = {
      '/w/near/last': 80,
      '/w/far/last': 500,
      '/w/loading/last': 10,
      '/w/failed/last': 10,
      '/w/done/last': 10
    }
    expect(
      fileExplorerDirsDueForMore(dirCache, new Set(['/w/loading']), projection(indexes), 40)
    ).toEqual(['/w/near'])
  })

  it('appends the next page, and a refresh started meanwhile wins', async () => {
    serveFolder(1_500)
    let dirCache: Record<string, DirCache> = {
      '/w': {
        children: [],
        operationOwner: { kind: 'local' },
        more: { nextOffset: 1_000, total: 1_500 }
      }
    }
    const setDirCache = (update: SetStateAction<Record<string, DirCache>>): void => {
      dirCache = typeof update === 'function' ? update(dirCache) : update
    }
    let loading: ReadonlySet<string> = new Set()
    const tracker = createFileExplorerDirLoadTracker()
    const params = {
      dirPath: '/w',
      activeWorktreeId: 'wt-1',
      worktreePath: '/w',
      dirLoadTracker: tracker,
      setDirCache,
      updateLoadingDirPaths: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
        loading = update(loading)
      }
    }

    await loadMoreFileExplorerDir({ ...params, dirCache, loadingDirPaths: loading })
    expect(dirCache['/w'].children).toHaveLength(500)
    expect(dirCache['/w'].children[0].name).toBe('f01000')
    expect(dirCache['/w'].more).toBeUndefined()
    expect(loading.size).toBe(0)

    dirCache = { '/w': { ...dirCache['/w'], children: [], more: { nextOffset: 0, total: 1_500 } } }
    const pending = loadMoreFileExplorerDir({ ...params, dirCache, loadingDirPaths: loading })
    tracker.begin('/w')
    await pending
    expect(dirCache['/w'].children).toHaveLength(0)
  })

  it('marks a failed page so scrolling does not retry it until a refresh', async () => {
    readRuntimeDirectoryPage.mockRejectedValueOnce(new Error('host gone'))
    let dirCache: Record<string, DirCache> = {
      '/w': { ...partial('/w/last'), operationOwner: { kind: 'local' } }
    }
    await loadMoreFileExplorerDir({
      dirPath: '/w',
      activeWorktreeId: 'wt-1',
      worktreePath: '/w',
      dirCache,
      loadingDirPaths: new Set(),
      dirLoadTracker: createFileExplorerDirLoadTracker(),
      setDirCache: (update) => {
        dirCache = typeof update === 'function' ? update(dirCache) : update
      },
      updateLoadingDirPaths: () => {}
    })
    expect(dirCache['/w'].error).toBeDefined()
    expect(fileExplorerDirsDueForMore(dirCache, new Set(), { getIndexByPath: () => 0 }, 0)).toEqual(
      []
    )
  })
})

describe('revealing a path in a partly listed folder', () => {
  it('reads on in the folder whose next path on the way is not listed yet', () => {
    const more = { nextOffset: 1_000, total: 5_000 }
    const listed = new Set(['/w/src'])
    const rows = { hasPath: (path: string) => listed.has(path) }
    const dirCache: Record<string, DirCache> = {
      '/w': { children: [] },
      '/w/src': { children: [], more }
    }
    expect(fileExplorerRevealDirToReadOn(dirCache, rows, ['/w/src', '/w/src/z.ts'])).toBe('/w/src')

    listed.add('/w/src/z.ts')
    expect(fileExplorerRevealDirToReadOn(dirCache, rows, ['/w/src', '/w/src/z.ts'])).toBeNull()
    // A fully listed or failed folder never reads on: the reveal falls back as before.
    expect(fileExplorerRevealDirToReadOn(dirCache, rows, ['/w/lib'])).toBeNull()
    dirCache['/w/src'] = { children: [], more, error: 'gone' }
    listed.delete('/w/src/z.ts')
    expect(fileExplorerRevealDirToReadOn(dirCache, rows, ['/w/src', '/w/src/z.ts'])).toBeNull()
  })
})
