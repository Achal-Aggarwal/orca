import {
  RpcBoolean,
  RpcNullableString,
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcString,
  RpcUnknown,
  RpcNonemptyString,
  RpcOptionalPositiveInteger,
  RpcOptionalFiniteNumber,
  RpcFiniteNumber
} from './rpc-value-schemas'
import { z } from 'zod'
import { isFeatureTipId } from '../feature-tips'
import {
  WORKTREE_CARD_PROPERTIES,
  normalizeWorktreeCardProperties
} from '../worktree/card-properties'
import { isPluginPanelTabKey } from '../plugins/plugin-manifest'
import { isFeatureInteractionId } from '../feature-interactions'
import type { FeatureInteractionId } from '../feature-interactions'
import { ACTIVITY_GROUP_BY_VALUES, THREAD_READ_FILTER_VALUES } from '../agents-view-thread-filters'
import { isReleaseChannel } from '../release-channel'
import type { ReleaseChannel } from '../release-channel'
import { ClientUiWorkspaceFilterFields } from './client-ui-workspace-filter-fields-params'
import { TaskResumeState } from './task-resume-state-params'
import { WorkspaceCleanup } from './workspace-cleanup-ui-params'
import { omitUndefinedValues, tolerateUnknownValues } from './ui-update-value-tolerance-params'

export const NullableString = RpcNullableString

export const StringArray = z.array(RpcString)

export const FeatureTipIds = z.array(
  z.custom(isFeatureTipId, { message: 'Unknown feature tip id' })
)

export const UnknownRecord = z.record(RpcString, RpcUnknown)

export const UnknownRecordArray = z.array(UnknownRecord)

export type StaticRightSidebarTab = (typeof STATIC_RIGHT_SIDEBAR_TABS)[number]

// Derive from the shared union; drift previously omitted cli and rejected whole client payloads.
export const WorktreeCardPropertyParam = z.enum(WORKTREE_CARD_PROPERTIES)

export const WorktreeCardProperties = z
  .array(WorktreeCardPropertyParam)
  .transform((value) => normalizeWorktreeCardProperties(value))

export const STATIC_RIGHT_SIDEBAR_TABS = [
  'explorer',
  'search',
  'vault',
  'workspaces',
  'pr-checks',
  'source-control',
  'checks',
  'ports'
] as const

// Plugin panels are open-ended `plugin:<publisher>.<id>/<panel>` keys, so the
// schema validates their shape rather than enumerating them.
export const RightSidebarTabParam = z.custom<StaticRightSidebarTab | `plugin:${string}`>(
  (value) =>
    typeof value === 'string' &&
    (STATIC_RIGHT_SIDEBAR_TABS.includes(value as StaticRightSidebarTab) ||
      isPluginPanelTabKey(value)),
  { message: 'Unknown right sidebar tab' }
)

export const AgentActivityDisplayMode = z.enum(['compact', 'full'])

export const StatusBarItem = z.enum([
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'cursor',
  'zcode',
  'ssh',
  'resource-usage',
  'ports'
])

export const WorkspaceStatusDefinition = z.object({
  id: RpcString,
  label: RpcString,
  color: RpcOptionalString,
  icon: RpcOptionalString
})

export const FeatureInteractionRecord = z
  .object({
    firstInteractedAt: RpcNumber.finite().nonnegative(),
    interactionCount: RpcOptionalPositiveInteger
  })
  .strict()

export const FeatureInteractions = z
  .record(RpcString, FeatureInteractionRecord)
  .superRefine((value, ctx) => {
    for (const id of Object.keys(value)) {
      if (!isFeatureInteractionId(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown feature interaction id: ${id}`,
          path: [id]
        })
      }
    }
  })

export const FeatureInteractionIdParam = z.custom<FeatureInteractionId>(isFeatureInteractionId, {
  message: 'Unknown feature interaction id'
})

export const TopLevelViewSchema = z.enum([
  'terminal',
  'settings',
  'tasks',
  'activity',
  'automations',
  'space',
  'skills',
  'artifacts',
  'mobile'
])

export const UiUpdateFields = z
  .object({
    lastActiveRepoId: NullableString.optional(),
    lastActiveWorktreeId: NullableString.optional(),
    // Why: sync hydration ignores this persisted startup view, so paired windows stay put.
    activeView: TopLevelViewSchema.optional(),
    sidebarWidth: RpcOptionalFiniteNumber,
    sidebarOpen: RpcOptionalBoolean,
    rightSidebarOpen: RpcOptionalBoolean,
    rightSidebarTab: RightSidebarTabParam.optional(),
    rightSidebarExplorerView: z.enum(['files', 'search']).optional(),
    rightSidebarWidth: RpcOptionalFiniteNumber,
    markdownTocPanelWidth: RpcOptionalFiniteNumber,
    combinedDiffFileTreeWidth: RpcOptionalFiniteNumber,
    groupBy: z.enum(['none', 'workspace-status', 'repo', 'pr-status']).optional(),
    showWorkspaceLineage: RpcOptionalBoolean,
    sortBy: z.enum(['name', 'smart', 'recent', 'repo', 'manual']).optional(),
    projectOrderBy: z.enum(['manual', 'recent']).optional(),
    showActiveOnly: RpcOptionalBoolean,
    hideSleepingWorkspaces: RpcOptionalBoolean,
    showSleepingWorkspaces: RpcOptionalBoolean,
    showInactiveWorkspaces: RpcOptionalBoolean,
    workspaceHostScope: RpcOptionalString,
    visibleWorkspaceHostIds: z.array(RpcString).nullable().optional(),
    agentsVisibleHostIds: z.array(RpcString).nullable().optional(),
    agentsFilterRepoIds: StringArray.optional(),
    agentsHideWorkspacesFromOtherDevices: RpcOptionalBoolean,
    agentsHideAutomationGeneratedWorkspaces: RpcOptionalBoolean,
    agentsHideCliCreatedWorkspaces: RpcOptionalBoolean,
    agentsShowChildAgents: RpcOptionalBoolean,
    agentsCompactMode: RpcOptionalBoolean,
    agentsShowSearch: RpcOptionalBoolean,
    agentsReadFilter: z.enum(THREAD_READ_FILTER_VALUES).optional(),
    agentsGroupBy: z.enum(ACTIVITY_GROUP_BY_VALUES).optional(),
    workspaceHostOrder: z.array(RpcString).optional(),
    automationHostFilter: z
      .union([
        z.object({ kind: z.literal('all') }).strict(),
        z.object({ kind: z.literal('host'), hostKey: RpcNonemptyString }).strict()
      ])
      .optional(),
    manualRepoOrder: z
      .array(z.object({ hostId: RpcString, repoId: RpcString }).strict())
      .optional(),
    ...ClientUiWorkspaceFilterFields,
    // Part of App.tsx’s debounced writer; missing fields reject the whole paired-client payload.
    explorerDisplayRootByWorktree: z.record(RpcString, RpcString).optional(),
    showDotfilesByWorktree: z.record(RpcString, RpcBoolean).optional(),
    collapsedGroups: StringArray.optional(),
    uiZoomLevel: RpcOptionalFiniteNumber,
    editorFontZoomLevel: RpcOptionalFiniteNumber,
    worktreeCardProperties: WorktreeCardProperties.optional(),
    _worktreeCardModeDefaulted: RpcOptionalBoolean,
    agentActivityDisplayMode: AgentActivityDisplayMode.optional(),
    workspaceStatuses: z.array(WorkspaceStatusDefinition).optional(),
    workspaceBoardOpacity: RpcOptionalFiniteNumber,
    workspaceBoardColumnWidth: RpcOptionalFiniteNumber,
    syncTaskStatusFromWorkspaceBoard: RpcOptionalBoolean,
    _workspaceStatusesDefaultOrderMigrated: RpcOptionalBoolean,
    _workspaceStatusesReorderedDefaultRepaired: RpcOptionalBoolean,
    _workspaceStatusesDefaultWorkflowMigrated: RpcOptionalBoolean,
    _workspaceStatusesDefaultVisualsMigrated: RpcOptionalBoolean,
    statusBarItems: z.array(StatusBarItem).optional(),
    _portsStatusBarDefaultAdded: RpcOptionalBoolean,
    _kimiStatusBarDefaultAdded: RpcOptionalBoolean,
    _minimaxStatusBarDefaultAdded: RpcOptionalBoolean,
    _antigravityStatusBarDefaultAdded: RpcOptionalBoolean,
    _grokStatusBarDefaultAdded: RpcOptionalBoolean,
    _cursorStatusBarDefaultAdded: RpcOptionalBoolean,
    _zcodeStatusBarDefaultAdded: RpcOptionalBoolean,
    statusBarVisible: RpcOptionalBoolean,
    usagePercentageDisplay: z.enum(['used', 'remaining']).optional(),
    statusBarUsageMode: z.enum(['verbose', 'compact']).optional(),
    dismissedUpdateVersion: NullableString.optional(),
    dismissedUnexpectedSignoutVersion: NullableString.optional(),
    lastUpdateCheckAt: RpcNumber.finite().nullable().optional(),
    pendingUpdateNudgeId: NullableString.optional(),
    dismissedUpdateNudgeId: NullableString.optional(),
    // Share the release-channel predicate so new channel overrides cannot silently fail parsing.
    releaseChannelOverride: z.custom<ReleaseChannel>(isReleaseChannel).nullable().optional(),
    notificationPermissionRequested: RpcOptionalBoolean,
    updateReassuranceSeen: RpcOptionalBoolean,
    osc52ClipboardDefaultOnNoticePending: RpcOptionalBoolean,
    acknowledgedAgentsByPaneKey: z.record(RpcString, RpcFiniteNumber).optional(),
    activityClearedAtByPaneKey: z.record(RpcString, RpcFiniteNumber).optional(),
    manuallyUnreadTurnsByPaneKey: z.record(RpcString, RpcFiniteNumber).optional(),
    browserDefaultUrl: NullableString.optional(),
    browserDefaultSearchEngine: z
      .enum(['google', 'duckduckgo', 'bing', 'kagi'])
      .nullable()
      .optional(),
    browserDefaultZoomLevel: RpcOptionalFiniteNumber,
    browserKagiSessionLink: NullableString.optional(),
    browserDevToolsDock: z
      .object({
        side: z.enum(['bottom', 'right']),
        bottomFraction: RpcFiniteNumber,
        rightFraction: RpcFiniteNumber
      })
      .optional(),
    windowBounds: z
      .object({
        x: RpcFiniteNumber,
        y: RpcFiniteNumber,
        width: RpcFiniteNumber,
        height: RpcFiniteNumber
      })
      .nullable()
      .optional(),
    windowMaximized: RpcOptionalBoolean,
    _sortBySmartMigrated: RpcOptionalBoolean,
    _inlineAgentsDefaultedForExperiment: RpcOptionalBoolean,
    _inlineAgentsDefaultedForAllUsers: RpcOptionalBoolean,
    trustedOrcaHooks: z.record(RpcString, RpcUnknown).optional(),
    setupScriptPromptDismissedRepoIds: StringArray.optional(),
    // Declare renderer one-shot dismissals to avoid whole-payload rejections for paired clients.
    setupGuideSidebarDismissed: RpcOptionalBoolean,
    setupGuideBrowserMilestoneMigrated: RpcOptionalBoolean,
    setupGuideBrowserMilestoneLegacyComplete: RpcOptionalBoolean,
    browserImportHintHidden: RpcOptionalBoolean,
    mobileEmulatorTabIntroDismissed: RpcOptionalBoolean,
    mobileEmulatorAgentSetupDismissed: RpcOptionalBoolean,
    projectOrderManualDefaultNoticeDismissed: RpcOptionalBoolean,
    usagePercentageDisplayChangeNoticeDismissed: RpcOptionalBoolean,
    statusBarCompactChangeNoticeDismissed: RpcOptionalBoolean,
    usageEmptyStateDismissed: RpcOptionalBoolean,
    codexTerminalServerIsolationNoticeSeen: RpcOptionalBoolean,
    codexSharedSettingsNoticeSeen: RpcOptionalBoolean,
    claudeDiffPanelNoticeSeen: RpcOptionalBoolean,
    claudeAccountSignInNoticeSeen: RpcOptionalBoolean,
    petVisible: RpcOptionalBoolean,
    petId: RpcOptionalString,
    customPets: UnknownRecordArray.optional(),
    petSize: RpcOptionalFiniteNumber,
    sidekickVisible: RpcOptionalBoolean,
    sidekickId: RpcOptionalString,
    customSidekicks: UnknownRecordArray.optional(),
    sidekickSize: RpcOptionalFiniteNumber,
    taskResumeState: TaskResumeState.optional(),
    workspaceCleanup: WorkspaceCleanup.optional(),
    featureTipsSeenIds: FeatureTipIds.optional(),
    featureInteractions: FeatureInteractions.optional(),
    contextualToursSeenIds: StringArray.optional(),
    contextualToursAutoEligible: RpcOptionalBoolean
  })
  .strict()

export const UiUpdate = z
  .object(tolerateUnknownValues(UiUpdateFields.shape))
  .strict()
  .default({})
  .transform(omitUndefinedValues)
