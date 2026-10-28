import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import {
  dirEntryPageAfter,
  FILE_READ_DIR_MAX_PAGE_ENTRIES,
  type DirEntryCursor,
  type DirEntryPage
} from '../../../../shared/file-dir-page'

/** Long enough to page through a folder as it scrolls; the cursor keeps an older listing correct. */
export const DIR_LISTING_PAGE_CACHE_TTL_MS = 30_000
const MAX_CACHED_LISTINGS = 8
/** A larger folder is re-listed for each page rather than held in memory. */
const MAX_CACHED_ENTRIES = 200_000

type DirPageRequest = {
  worktree: string
  relativePath: string
  followSymlinks?: boolean
  after?: DirEntryCursor
  limit?: number
}

type CachedListing = { worktree: string; entries: DirEntry[]; listedAt: number }

/**
 * One sorted listing per (connection, folder), so later pages skip re-listing. Pages start after a
 * cursor, not at an offset: a listing that expired, was evicted or changed between pages never
 * skips or repeats an entry, so this cache only saves work.
 */
export class DirListingPageCache {
  private readonly listings = new Map<string, CachedListing>()
  private cachedEntries = 0

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Page one always re-lists, so a refresh never reads a listing older than itself. */
  async readPage(
    connectionId: string | undefined,
    request: DirPageRequest,
    list: () => Promise<DirEntry[]>
  ): Promise<DirEntryPage> {
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
    const cached = key !== null && request.after ? this.take(key) : null
    const listing = cached ?? {
      worktree: request.worktree,
      entries: await list(),
      listedAt: this.now()
    }
    const page = dirEntryPageAfter(
      listing.entries,
      request.after,
      request.limit ?? FILE_READ_DIR_MAX_PAGE_ENTRIES
    )
    if (key !== null) {
      this.remember(key, listing, page.hasMore)
    }
    return page
  }

  /** The host's watcher saw a change in this workspace: drop its listings so none outlives it. */
  forgetWorkspace(worktree: string): void {
    for (const [key, listing] of this.listings) {
      if (listing.worktree === worktree) {
        this.forget(key)
      }
    }
  }

  private take(key: string): CachedListing | null {
    const hit = this.listings.get(key)
    if (!hit || this.now() - hit.listedAt >= DIR_LISTING_PAGE_CACHE_TTL_MS) {
      return null
    }
    return hit
  }

  private remember(key: string, listing: CachedListing, morePages: boolean): void {
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
