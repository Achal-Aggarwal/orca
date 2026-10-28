import type { ExecutionHostId } from '../../../../shared/execution-host'

export type FileExplorerOperationOwner =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'runtime'; environmentId: string; executionHostId: ExecutionHostId }
  | { kind: 'unresolved' }

export type TreeNode = {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  /** Inferred from an opened link, not the parent's latest host listing. */
  isDirectoryFromOpenedLink?: boolean
  depth: number
  /** Host snapshot that produced this node. Destructive actions fail closed without it. */
  operationOwner?: FileExplorerOperationOwner
}

/** Keep loading outside dirCache to avoid rebuilding the tree; see file-explorer-dir-load-state.ts. */
/** Where the next page of a partly listed folder starts on its host, and how many entries it has. */
export type FileExplorerDirMore = { nextOffset: number; total: number }

export type DirCache = {
  error?: string
  children: TreeNode[]
  operationOwner?: FileExplorerOperationOwner
  /** Present while the host holds entries not yet listed here. */
  more?: FileExplorerDirMore
}

/** Retry covered dir reads after supersession, but not unreadable roots, which would add one dead transport timeout per dir. */
export type FileExplorerTreeRefreshOutcome = 'refreshed' | 'superseded' | 'root-unreadable'
