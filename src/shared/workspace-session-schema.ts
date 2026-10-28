import {
  ScalarBoolean,
  ScalarFiniteNumber,
  ScalarNonemptyString,
  ScalarNonnegativeInteger,
  ScalarNullableString,
  ScalarNumber,
  ScalarOptionalBoolean,
  ScalarOptionalNonemptyString,
  ScalarOptionalNullableString,
  ScalarOptionalNumber,
  ScalarOptionalString,
  ScalarString
} from './scalar-value-schemas'
// Validate persisted sessions at read boundaries so malformed legacy data never reaches React. Ignore unknown fields, validate fields we read, and salvage independent entries via zod-salvage; only non-session payloads reset to defaults.
import { z } from 'zod'
import {
  leafStringsSchema,
  terminalLayoutSnapshotSchema,
  terminalPaneLayoutNodeSchema
} from './terminal-layout-snapshot-schema'
import { closedTerminalPaneSchema } from './closed-terminal-panes'
import { closedTerminalTabTombstoneSchema } from './closed-terminal-tab-tombstones'
import type { WorkspaceKey } from './folder-workspace-types'
import type { TabGroupLayoutNode } from './tab-types'
import type { TuiAgent } from './tui-agent'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { terminalTabIdSchema } from './terminal-tab-id-schema'
import { terminalSurfaceTombstoneSchema } from './terminal-surface-tombstone-schema'
import { parseExecutionHostId, type ExecutionHostId } from './execution-host'
import { isTuiAgent } from './tui-agent-config'
import { isWorkspaceKey } from './workspace-scope'
import {
  browserHistoryEntriesSchema,
  workspaceDocHistoryEntriesSchema,
  browserPageSchema,
  browserWorkspaceSchema
} from './workspace-session-browser-schema'
import { workspaceSessionCloseIntentFieldSchemas } from './workspace-session-close-intent-schema'
import { persistedClientHostedBrowserPageSchema } from './client-hosted-browser-page-record'
import { persistedOpenFileSchema } from './workspace-session-editor-schema'
import { sleepingAgentSessionsByPaneKeySchema } from './workspace-session-sleeping-agents'
import {
  tabContentTypeSchema,
  workspaceVisibleTabTypeSchema
} from './workspace-session-tab-type-schema'
import { salvagedField, salvagedOptional, salvagingArray, salvagingRecord } from './zod-salvage'
import { isStructuredAgentId } from './agent-session-provider-handle-encoding'

const workspaceKeySchema = z.custom<WorkspaceKey>(
  (value) => typeof value === 'string' && isWorkspaceKey(value)
)

export const terminalTabSchema = z.object({
  id: terminalTabIdSchema,
  ptyId: ScalarNullableString,
  worktreeId: ScalarString,
  title: ScalarString,
  defaultTitle: ScalarOptionalString,
  generatedTitle: ScalarOptionalNullableString,
  aiVaultTitle: z
    .object({
      agent: z.enum(['claude', 'codex']),
      sessionId: ScalarString,
      title: ScalarString
    })
    .nullable()
    .optional()
    .catch(undefined),
  quickCommandLabel: ScalarOptionalNullableString,
  customTitle: ScalarNullableString,
  color: ScalarNullableString,
  isPinned: ScalarOptionalBoolean,
  // Preserve chat ownership through restore; missing/unknown modes safely default to terminal, matching unified tabs.
  viewMode: z.enum(['terminal', 'chat']).catch('terminal').optional(),
  sortOrder: ScalarNumber,
  createdAt: ScalarNumber,
  generation: ScalarOptionalNumber,
  startupCwd: ScalarOptionalNonemptyString,
  // Retain the idle agent icon before hooks fire; unknown IDs degrade to absent without resetting the session.
  launchAgent: z
    .custom<TuiAgent>((v) => isTuiAgent(v))
    .optional()
    .catch(undefined)
})

const executionHostIdSchema = z.custom<ExecutionHostId>(
  (value) => typeof value === 'string' && Boolean(parseExecutionHostId(value))
)

const tabSchema = z.object({
  id: ScalarString,
  entityId: ScalarString,
  groupId: ScalarString,
  worktreeId: ScalarString,
  executionHostId: executionHostIdSchema.optional(),
  contentType: tabContentTypeSchema,
  // Accept registered agent slugs across mixed versions; invalid slugs become absent rather than rejecting the session.
  agentSessionAgent: ScalarString.refine((value) => isStructuredAgentId(value))
    .optional()
    .catch(undefined),
  label: ScalarString,
  generatedLabel: ScalarOptionalNullableString,
  aiVaultTitle: z
    .object({
      agent: z.enum(['claude', 'codex']),
      sessionId: ScalarString,
      title: ScalarString
    })
    .nullable()
    .optional()
    .catch(undefined),
  quickCommandLabel: ScalarOptionalNullableString,
  customLabel: ScalarNullableString,
  color: ScalarNullableString,
  sortOrder: ScalarNumber,
  createdAt: ScalarNumber,
  // Why: corrupt optional recency must not discard the whole persisted tab.
  lastFocusedAt: ScalarFiniteNumber.nonnegative().optional().catch(undefined),
  isPreview: ScalarOptionalBoolean,
  isPinned: ScalarOptionalBoolean,
  // Preserve chat mode on restore; unknown future values degrade to terminal and missing legacy values remain absent.
  viewMode: z.enum(['terminal', 'chat']).catch('terminal').optional()
})

const tabGroupSchema = z.object({
  id: ScalarString,
  worktreeId: ScalarString,
  activeTabId: ScalarNullableString,
  tabOrder: z.array(ScalarString),
  recentTabIds: z.array(ScalarString).optional()
})

const tabGroupSplitDirectionSchema = z.enum(['horizontal', 'vertical'])

const tabGroupLayoutNodeSchema: z.ZodType<TabGroupLayoutNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('leaf'),
      groupId: z.string()
    }),
    z.object({
      type: z.literal('split'),
      direction: tabGroupSplitDirectionSchema,
      first: tabGroupLayoutNodeSchema,
      second: tabGroupLayoutNodeSchema,
      ratio: z.number().optional()
    })
  ])
)

const worktreeIdSchema = ScalarString

export const workspaceSessionStateSchema: z.ZodType<WorkspaceSessionState> = z.object({
  activeRepoId: salvagedField('activeRepoId', ScalarNullableString, () => null),
  activeWorkspaceKey: salvagedOptional('activeWorkspaceKey', workspaceKeySchema.nullable()),
  activeWorkspaceExecutionHostId: salvagedOptional(
    'activeWorkspaceExecutionHostId',
    executionHostIdSchema.nullable()
  ),
  activeWorktreeId: salvagedField('activeWorktreeId', ScalarNullableString, () => null),
  activeTabId: salvagedField('activeTabId', ScalarNullableString, () => null),
  tabsByWorktree: salvagedField(
    'tabsByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(terminalTabSchema)),
    () => ({})
  ),
  terminalLayoutsByTabId: salvagedField(
    'terminalLayoutsByTabId',
    salvagingRecord(terminalTabIdSchema, terminalLayoutSnapshotSchema),
    () => ({})
  ),
  // Client-local park scrollback stays outside layout snapshots so remote projection cannot upload it; older profiles may omit it.
  localOnlyScrollbackByTabId: salvagedOptional(
    'localOnlyScrollbackByTabId',
    salvagingRecord(terminalTabIdSchema, leafStringsSchema)
  ),
  activeWorktreeIdsOnShutdown: salvagedOptional(
    'activeWorktreeIdsOnShutdown',
    salvagingArray(worktreeIdSchema)
  ),
  openFilesByWorktree: salvagedOptional(
    'openFilesByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(persistedOpenFileSchema))
  ),
  activeFileIdByWorktree: salvagedOptional(
    'activeFileIdByWorktree',
    salvagingRecord(worktreeIdSchema, ScalarNullableString)
  ),
  markdownFrontmatterVisible: salvagedOptional(
    'markdownFrontmatterVisible',
    salvagingRecord(ScalarString, ScalarBoolean)
  ),
  browserTabsByWorktree: salvagedOptional(
    'browserTabsByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(browserWorkspaceSchema))
  ),
  browserPagesByWorkspace: salvagedOptional(
    'browserPagesByWorkspace',
    salvagingRecord(ScalarString, salvagingArray(browserPageSchema))
  ),
  activeBrowserTabIdByWorktree: salvagedOptional(
    'activeBrowserTabIdByWorktree',
    salvagingRecord(worktreeIdSchema, ScalarNullableString)
  ),
  clientHostedBrowserPagesByWorktree: salvagedOptional(
    'clientHostedBrowserPagesByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(persistedClientHostedBrowserPageSchema))
  ),
  ...workspaceSessionCloseIntentFieldSchemas,
  activeTabTypeByWorktree: salvagedOptional(
    'activeTabTypeByWorktree',
    salvagingRecord(worktreeIdSchema, workspaceVisibleTabTypeSchema)
  ),
  browserUrlHistory: salvagedOptional('browserUrlHistory', browserHistoryEntriesSchema),
  workspaceDocHistory: salvagedOptional('workspaceDocHistory', workspaceDocHistoryEntriesSchema),
  activeTabIdByWorktree: salvagedOptional(
    'activeTabIdByWorktree',
    salvagingRecord(worktreeIdSchema, ScalarNullableString)
  ),
  unifiedTabs: salvagedOptional(
    'unifiedTabs',
    salvagingRecord(worktreeIdSchema, salvagingArray(tabSchema))
  ),
  tabGroups: salvagedOptional(
    'tabGroups',
    salvagingRecord(worktreeIdSchema, salvagingArray(tabGroupSchema))
  ),
  tabGroupLayouts: salvagedOptional(
    'tabGroupLayouts',
    salvagingRecord(worktreeIdSchema, tabGroupLayoutNodeSchema)
  ),
  activeGroupIdByWorktree: salvagedOptional(
    'activeGroupIdByWorktree',
    salvagingRecord(worktreeIdSchema, ScalarString)
  ),
  activeConnectionIdsAtShutdown: salvagedOptional(
    'activeConnectionIdsAtShutdown',
    salvagingArray(ScalarString)
  ),
  remoteSessionIdsByTabId: salvagedOptional(
    'remoteSessionIdsByTabId',
    salvagingRecord(terminalTabIdSchema, ScalarString)
  ),
  // Why: the sort comparator in order-empty-query-worktrees.ts would produce NaN
  // (undefined sort order) from a NaN or Infinity persisted here.
  lastVisitedAtByWorktreeId: salvagedOptional(
    'lastVisitedAtByWorktreeId',
    salvagingRecord(worktreeIdSchema, ScalarFiniteNumber.nonnegative())
  ),
  defaultTerminalTabsAppliedByWorktreeId: salvagedOptional(
    'defaultTerminalTabsAppliedByWorktreeId',
    salvagingRecord(worktreeIdSchema, z.literal(true))
  ),
  sleepingAgentSessionsByPaneKey: salvagedOptional(
    'sleepingAgentSessionsByPaneKey',
    sleepingAgentSessionsByPaneKeySchema
  ),
  terminalPtyIncarnationsByPaneKey: salvagedOptional(
    'terminalPtyIncarnationsByPaneKey',
    salvagingRecord(ScalarString, ScalarNonemptyString.max(128))
  ),
  terminalTopologyRevisionByRepoId: salvagedOptional(
    'terminalTopologyRevisionByRepoId',
    salvagingRecord(ScalarString, ScalarNonnegativeInteger)
  ),
  terminalSurfaceTombstonesByPaneKey: salvagedOptional(
    'terminalSurfaceTombstonesByPaneKey',
    salvagingRecord(ScalarString, terminalSurfaceTombstoneSchema)
  ),
  closedTerminalTabTombstonesByTabId: salvagedOptional(
    'closedTerminalTabTombstonesByTabId',
    salvagingRecord(terminalTabIdSchema, closedTerminalTabTombstoneSchema)
  ),
  closedTerminalPanesByPaneKey: salvagedOptional(
    'closedTerminalPanesByPaneKey',
    salvagingRecord(ScalarNonemptyString, closedTerminalPaneSchema)
  )
})

export type ParsedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState }
  | { ok: false; error: string }

/** Report only the first divergent field to keep repair diagnostics actionable. */
export function describeWorkspaceSessionError(error: z.ZodError): string {
  const firstIssue = error.issues[0]
  const path = firstIssue?.path.join('.') || '<root>'
  return `${path}: ${firstIssue?.message ?? 'invalid session'}`
}

export const WORKSPACE_SESSION_UNVALIDATABLE = '<root>: session could not be validated'

/** Return null if validation itself throws: materializing hundreds of thousands of Zod issues can overflow during Store construction and otherwise prevent launch. */
export function safeParseWorkspaceSession(
  raw: unknown
): ReturnType<typeof workspaceSessionStateSchema.safeParse> | null {
  try {
    return workspaceSessionStateSchema.safeParse(raw)
  } catch {
    return null
  }
}

export function parseWorkspaceSession(raw: unknown): ParsedWorkspaceSession {
  const result = safeParseWorkspaceSession(raw)
  if (!result) {
    return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
  }
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: describeWorkspaceSessionError(result.error) }
}

export { terminalPaneLayoutNodeSchema }
