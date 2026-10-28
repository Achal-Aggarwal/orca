import {
  RpcNull,
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalNullableString,
  RpcString,
  RpcUnknown
} from './rpc-value-schemas'
import { z } from 'zod'
import { normalizeExecutionHostId } from '../execution-host'
import { isTuiAgent } from '../tui-agent-config'
import type { TuiAgent } from '../tui-agent'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  TriStateLinkedIssue
} from './rpc-param-primitives'
import { RUNTIME_NAVIGATION_TARGETS } from '../runtime-navigation'
import { WorkspaceLinkedItemSchema } from '../workspace-linked-item-schema'
import { WorkspaceAttachmentsSchema } from '../workspace-attachment-schema'
import { DiffCommentSchema, MobileDiffReviewSchema } from '../diff-comment-schema'
import { TaskSourceContextSchema } from '../task-source-context-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../workspace-linked-item-source-context'

export const OptionalExecutionHostId = RpcString.transform((value, ctx) => {
  const hostId = normalizeExecutionHostId(value)
  if (!hostId) {
    ctx.addIssue({ code: 'custom', message: 'Invalid host id' })
    return z.NEVER
  }
  return hostId
}).optional()

export const OptionalTuiAgent = RpcUnknown.superRefine((value, ctx) => {
  if (value !== undefined && !isTuiAgent(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown TUI agent' })
  }
})
  .transform((value): TuiAgent | undefined => (isTuiAgent(value) ? value : undefined))
  .optional()

export const AutomationWorkspaceProvenanceRequest = z.object({
  automationId: RpcString,
  automationRunId: RpcString,
  dispatchToken: RpcString,
  createRequestId: RpcString
})

// Descriptive provenance grants no authority; the host stamps createdAt to avoid client-clock sort skew.
export const CliWorkspaceProvenanceRequest = z.object({
  callerTerminalHandle: OptionalString
})

export const WorktreeListParams = z.object({
  repo: OptionalString,
  limit: OptionalFiniteNumber
})

export const WorktreeDetectedListParams = z.object({
  repo: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing repo selector')
  )
})

export const WorktreeTeardownMissingTerminalsParams = WorktreeDetectedListParams.extend({
  worktreeIds: z.array(RpcString.min(1)).max(10_000),
  connectionId: RpcOptionalNullableString
})

export const WorktreePsParams = z.object({
  limit: OptionalFiniteNumber,
  afterSnapshotId: RpcString.min(1).max(128).nullable().optional(),
  supportsWorktreeVisibilitySourceDefaults: z.literal(true).optional(),
  // Opt-in: wait lookups read screens and probe PTYs, too costly for pollers; older hosts omit agentWait.
  includeAgentWait: z.literal(true).optional()
})

export const WorktreeSortOrder = z.object({
  orderedIds: z.array(RpcString),
  // Parallel to orderedIds: the copy each id names, so a same-id twin keeps its own order.
  hostIds: z.array(RpcString).optional()
})

export const WorktreeSelector = z.object({
  worktree: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing worktree selector')
  )
})

// Why optional: an older host strips the unknown field and marks its chats asleep as before.
export const WorktreeSleepParams = WorktreeSelector.extend({
  markChatsAsleep: RpcOptionalBoolean
})

export const WorktreeActivate = WorktreeSelector.extend({
  notifyClients: OptionalBoolean,
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional()
})

/** Shared by WorktreeCreate and WorktreeSet so the two error messages cannot drift. */
export function assertLinkedWorkItemSourceContextMatch(
  params: {
    linkedWorkItem?: z.infer<typeof WorkspaceLinkedItemSchema> | null
    linkedTaskSourceContext?: z.infer<typeof TaskSourceContextSchema> | null
  },
  ctx: z.RefinementCtx
): void {
  if (
    params.linkedWorkItem &&
    params.linkedTaskSourceContext &&
    !isWorkspaceLinkedItemSourceContextMatch(params.linkedWorkItem, params.linkedTaskSourceContext)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Linked work item and source context identities must match'
    })
  }
}

export const WorktreeSet = WorktreeSelector.extend({
  // Empty clears to branch/folder fallback; OptionalString would drop remote clears and restore the old name.
  displayName: OptionalPlainString,
  // Preserve empty comment updates instead of coercing them to absent.
  comment: OptionalPlainString,
  linkedIssue: TriStateLinkedIssue,
  linkedPR: TriStateLinkedIssue,
  suppressedGitHubPR: RpcNumber.int().positive().nullable().optional(),
  linkedLinearIssue: z.union([RpcString, RpcNull]).optional(),
  linkedLinearIssueWorkspaceId: z.union([RpcString, RpcNull]).optional(),
  linkedLinearIssueOrganizationUrlKey: z.union([RpcString, RpcNull]).optional(),
  linkedGitLabMR: TriStateLinkedIssue,
  linkedGitLabIssue: TriStateLinkedIssue,
  linkedBitbucketPR: TriStateLinkedIssue,
  linkedAzureDevOpsPR: TriStateLinkedIssue,
  linkedGiteaPR: TriStateLinkedIssue,
  linkedWorkItem: WorkspaceLinkedItemSchema.nullable().optional(),
  linkedItems: WorkspaceAttachmentsSchema.optional(),
  linkedItemsBase: WorkspaceAttachmentsSchema.optional(),
  linkedItemsSelectionChanged: RpcOptionalBoolean,
  linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
  isArchived: OptionalBoolean,
  isUnread: OptionalBoolean,
  isPinned: OptionalBoolean,
  sortOrder: OptionalFiniteNumber,
  manualOrder: OptionalFiniteNumber,
  lastActivityAt: OptionalFiniteNumber,
  createdAt: OptionalFiniteNumber,
  sparseDirectories: z.array(RpcString).optional(),
  sparseBaseRef: OptionalString,
  sparsePresetId: OptionalString,
  baseRef: OptionalString,
  workspaceStatus: OptionalString,
  pushTarget: z
    .object({
      remoteName: RpcString,
      branchName: RpcString,
      remoteUrl: OptionalString
    })
    .nullable()
    .optional(),
  // Older clients may send unsupported review shapes alongside unrelated metadata edits.
  diffComments: z.array(DiffCommentSchema).optional().catch(undefined),
  mobileDiffReview: MobileDiffReviewSchema.optional().catch(undefined),
  parentWorktree: OptionalString,
  noParent: OptionalBoolean
}).superRefine((params, ctx) => {
  assertLinkedWorkItemSourceContextMatch(params, ctx)
  if (params.parentWorktree && params.noParent === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Choose either --parent-worktree or --no-parent, not both.'
    })
  }
})

export const WorktreeRemove = WorktreeSelector.extend({
  hostId: OptionalExecutionHostId,
  force: OptionalBoolean,
  // Desktop force also means ordinary confirmed delete; PTY-stop waivers need their own field (#11960).
  allowUnverifiedPtyStop: OptionalBoolean,
  runHooks: OptionalBoolean,
  // Waive failed-hook refusal explicitly and record it; independent of force and whether hooks run (#19334).
  allowFailedArchiveHook: OptionalBoolean
})

export const WorktreeForceDeleteBranch = WorktreeSelector.extend({
  hostId: OptionalExecutionHostId,
  branchName: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing branch name')
  ),
  expectedHead: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing expected branch head')
  )
})

export const WorktreeResolvePrBase = z.object({
  repo: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing repo selector')
  ),
  prNumber: RpcUnknown.transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)).pipe(
    RpcNumber.int().positive('Missing PR number')
  ),
  headRefName: OptionalString,
  baseRefName: OptionalString,
  isCrossRepository: OptionalBoolean
})

export const WorktreeResolveMrBase = z.object({
  repo: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing repo selector')
  ),
  mrIid: RpcUnknown.transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)).pipe(
    RpcNumber.int().positive('Missing MR number')
  ),
  sourceBranch: OptionalString,
  targetBranch: OptionalString,
  isCrossRepository: OptionalBoolean
})
