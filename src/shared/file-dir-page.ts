import type { DirEntry } from './filesystem-entry-types'

/** One page of a folder's sorted listing; `total` counts the whole folder. */
export type DirEntryPage = { entries: DirEntry[]; total: number }

/** The most entries a host returns in one page; even long names keep it far below a remote reply's cap. */
export const FILE_READ_DIR_MAX_PAGE_ENTRIES = 5_000
