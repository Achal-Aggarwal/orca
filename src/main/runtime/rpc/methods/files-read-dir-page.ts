import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { FILE_READ_DIR_MAX_PAGE_ENTRIES, type DirEntryPage } from '../../../../shared/file-dir-page'

/** Long enough to page through a folder as it scrolls, short enough that a refresh sees changes. */
export const DIR_LISTING_PAGE_CACHE_TTL_MS = 30_000
const MAX_CACHED_LISTINGS = 8
/** A larger folder is re-listed for each page rather than held in memory. */
const MAX_CACHED_ENTRIES = 200_000

type DirPageRequest = {
  worktree: string
  relativePath: string
  followSymlinks?: boolean
  offset?: number
  limit?: number
}

/** One sorted listing per (connection, folder): later pages slice it instead of re-listing. */
export class DirListingPageCache {
  private readonly listings = new Map<string, { entries: DirEntry[]; listedAt: number }>()
  private cachedEntries = 0

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Page one always re-lists, so a refresh never reads a listing older than itself. */
  async readPage(
    connectionId: string | undefined,
    request: DirPageRequest,
    list: () => Promise<DirEntry[]>
  ): Promise<DirEntryPage> {
    const offset = request.offset ?? 0
    const limit = request.limit ?? FILE_READ_DIR_MAX_PAGE_ENTRIES
    // Why per connection: a socket that never listed this folder cannot read another's snapshot.
    const key =
      connectionId === undefined
        ? null
        : JSON.stringify([
            connectionId,
            request.worktree,
            request.relativePath,
            request.followSymlinks === true
          ])
    const cached = key !== null && offset > 0 ? this.take(key) : null
    const listing = cached ?? { entries: await list(), listedAt: this.now() }
    if (key !== null) {
      this.remember(key, listing, offset + limit < listing.entries.length)
    }
    return {
      entries: listing.entries.slice(offset, offset + limit),
      total: listing.entries.length
    }
  }

  private take(key: string): { entries: DirEntry[]; listedAt: number } | null {
    const hit = this.listings.get(key)
    if (!hit || this.now() - hit.listedAt >= DIR_LISTING_PAGE_CACHE_TTL_MS) {
      return null
    }
    return hit
  }

  private remember(
    key: string,
    listing: { entries: DirEntry[]; listedAt: number },
    morePages: boolean
  ): void {
    this.forget(key)
    if (!morePages || listing.entries.length > MAX_CACHED_ENTRIES) {
      return
    }
    this.listings.set(key, listing)
    this.cachedEntries += listing.entries.length
    for (const oldest of this.listings.keys()) {
      if (this.listings.size <= MAX_CACHED_LISTINGS && this.cachedEntries <= MAX_CACHED_ENTRIES) {
        break
      }
      this.forget(oldest)
    }
  }

  private forget(key: string): void {
    const listing = this.listings.get(key)
    if (listing) {
      this.listings.delete(key)
      this.cachedEntries -= listing.entries.length
    }
  }
}

export const dirListingPageCache = new DirListingPageCache()
