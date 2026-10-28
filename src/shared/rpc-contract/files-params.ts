import {
  RpcNullableString,
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcString,
  RpcUnknown
} from './rpc-value-schemas'
import { PATH_EXISTENCE_BATCH_MAX } from '../path-existence-batch'
import { z } from 'zod'
import { QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS } from '../quick-open-path-search'
import { RUNTIME_NAVIGATION_TARGETS } from '../runtime-navigation'
import { FileOpen, WorktreeSelector } from './files-target-params'

export const FilePathsExist = WorktreeSelector.extend({
  relativePaths: z.array(RpcString).max(PATH_EXISTENCE_BATCH_MAX)
})

export const FilePathSearch = WorktreeSelector.extend({
  allowLegacyIncludeIgnored: RpcOptionalBoolean,
  includeIgnored: RpcOptionalBoolean,
  followSymlinks: RpcOptionalBoolean,
  query: RpcString.max(QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS).default(''),
  limit: RpcNumber.int().positive().max(32).default(16),
  excludePaths: z.array(RpcString).optional(),
  mode: z.literal('quick-open').optional()
})

export const ResolveTerminalPath = WorktreeSelector.extend({
  pathText: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing path text')
  ),
  terminal: RpcUnknown.transform((v) => (typeof v === 'string' && v.length > 0 ? v : null))
    .nullable()
    .optional(),
  cwd: RpcUnknown.transform((v) => (typeof v === 'string' && v.length > 0 ? v : null))
    .nullable()
    .optional(),
  crossWorkspace: RpcUnknown.transform((v) => v === true).optional(),
  nativeChatContext: z
    .object({
      tabId: RpcString.min(1),
      sessionId: RpcString.min(1)
    })
    .optional()
})

// Why: absent `navigation` (phones, older CLIs) keeps the original host switch; 'caller'/'clients' open without moving it.
const FileOpenTarget = FileOpen.extend({
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional()
})

export const FileOpenTab = FileOpenTarget.extend({
  line: RpcNumber.int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  column: RpcNumber.int().positive().max(Number.MAX_SAFE_INTEGER).optional()
}).refine((params) => params.column === undefined || params.line !== undefined, {
  message: 'column requires line',
  path: ['column']
})

export const FileOpenDiff = FileOpenTarget.extend({
  staged: RpcOptionalBoolean
})

export const DocPreviewFileRead = FileOpen.extend({
  entryRelativePath: RpcString.min(1),
  implicitRootRelativePath: RpcNullableString,
  authorizedRootRelativePaths: z.array(RpcString)
})

export const FileTreePath = WorktreeSelector.extend({
  followSymlinks: RpcOptionalBoolean,
  relativePath: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(RpcString)
})

export const ServerDirectoryBrowse = z.object({
  path: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(RpcString)
})

export const FileReadChunk = FileOpen.extend({
  offset: RpcNumber.int().nonnegative(),
  length: RpcNumber.int()
    .positive()
    .max(512 * 1024)
})

export const FileSearch = WorktreeSelector.extend({
  query: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing search query')
  ),
  caseSensitive: RpcOptionalBoolean,
  wholeWord: RpcOptionalBoolean,
  useRegex: RpcOptionalBoolean,
  includePattern: RpcOptionalString,
  excludePattern: RpcOptionalString,
  maxResults: RpcNumber.int().positive().optional()
})

// Optional maxResults aligns remote callers with desktop caps; older hosts strip it and retain their defaults.
export const FileListAll = WorktreeSelector.extend({
  candidatePaths: z
    .array(RpcString.max(64 * 1024))
    .max(100)
    .optional(),
  includeIgnored: RpcOptionalBoolean,
  followSymlinks: RpcOptionalBoolean,
  excludePaths: z.array(RpcString).optional(),
  maxResults: RpcNumber.int().positive().optional()
})

export const FileUnwatch = z.object({
  subscriptionId: RpcUnknown.transform((value) =>
    typeof value === 'string' && value.length > 0 ? value : ''
  ).pipe(RpcString.min(1, 'Missing subscriptionId'))
})
