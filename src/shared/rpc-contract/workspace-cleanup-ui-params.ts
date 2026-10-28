import { RpcNumber, RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import { normalizeWorkspaceCleanupBrowseState } from '../workspace-cleanup-browse-state'
import type { WorkspaceCleanupBrowseState } from '../workspace-cleanup-browse-state'

export const WorkspaceCleanupDismissal = z.object({
  worktreeId: RpcString,
  dismissedAt: RpcNumber.finite(),
  fingerprint: RpcString,
  classifierVersion: RpcNumber.finite(),
  executionHostId: RpcString.min(1).optional()
})

/** Normalize filters field by field: strict/enumerated input would reject all ui.set state when newer clients add filters. */
export const WorkspaceCleanupBrowse = z
  .custom<WorkspaceCleanupBrowseState>()
  .transform((value) => normalizeWorkspaceCleanupBrowseState(value))

export const WorkspaceCleanup = z.object({
  dismissals: z.record(RpcString, WorkspaceCleanupDismissal),
  browse: WorkspaceCleanupBrowse.optional()
})
