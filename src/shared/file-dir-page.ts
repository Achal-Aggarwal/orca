import type { DirEntry } from './filesystem-entry-types'

/** One page of a folder's sorted listing; `total` counts the whole folder. */
export type DirEntryPage = { entries: DirEntry[]; total: number }

const TOO_MANY_FOR_REMOTE = 'too many to list over a remote connection.'

/** Every host build refuses an unpaged listing past the reply budget with this wording. */
export function dirListingTooLargeForRemoteMessage(entryCount: number): string {
  return `This folder has ${entryCount.toLocaleString('en-US')} entries, ${TOO_MANY_FOR_REMOTE}`
}

export function isDirListingTooLargeForRemoteError(error: unknown): boolean {
  return error instanceof Error && error.message.endsWith(TOO_MANY_FOR_REMOTE)
}

/** The most entries a host returns in one page; even long names keep it far below a remote reply's cap. */
export const FILE_READ_DIR_MAX_PAGE_ENTRIES = 5_000
