import {
  RpcNull,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcString,
  RpcUndefined,
  RpcUnknown
} from './rpc-value-schemas'
import { z } from 'zod'
import { WorkspaceAttachmentsSchema } from '../workspace-attachment-schema'
import { WorkspaceLinkedItemSchema } from '../workspace-linked-item-schema'
import { TaskSourceContextSchema } from '../task-source-context-schema'
import { workspaceSourceSchema } from '../telemetry-events'
import { RUNTIME_NAVIGATION_TARGETS } from '../runtime-navigation'
import { sleepingAgentLaunchConfigSchema } from '../workspace-session-sleeping-agents'
import { isTuiAgent } from '../tui-agent-config'
import { LaunchSourceParam } from './launch-source-param'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalString,
  TriStateLinkedIssue
} from './rpc-param-primitives'
import {
  AutomationWorkspaceProvenanceRequest,
  CliWorkspaceProvenanceRequest,
  OptionalExecutionHostId,
  OptionalTuiAgent,
  assertLinkedWorkItemSourceContextMatch
} from './worktree-params'

export const WorktreeCreate = z
  .object({
    repo: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
      RpcString.min(1, 'Missing repo selector')
    ),
    /** Scope same-ID repo copies by host; absent retains legacy selector lookup, which refuses ambiguous IDs. */
    repoHostId: OptionalExecutionHostId,
    name: OptionalString,
    /** Generated names may skip/retire candidates; absent means user-typed and bypasses that policy. */
    nameWasGenerated: RpcOptionalBoolean,
    baseBranch: OptionalString,
    compareBaseRef: OptionalString,
    branchNameOverride: OptionalString,
    branchIntent: z.literal('open-existing').optional(),
    linkedIssue: TriStateLinkedIssue,
    linkedPR: TriStateLinkedIssue,
    linkedLinearIssue: RpcOptionalString,
    linkedLinearIssueWorkspaceId: z.union([RpcString, RpcNull]).optional(),
    linkedLinearIssueOrganizationUrlKey: z.union([RpcString, RpcNull]).optional(),
    linkedGitLabMR: TriStateLinkedIssue,
    linkedGitLabIssue: TriStateLinkedIssue,
    linkedBitbucketPR: TriStateLinkedIssue,
    linkedAzureDevOpsPR: TriStateLinkedIssue,
    linkedGiteaPR: TriStateLinkedIssue,
    linkedWorkItem: WorkspaceLinkedItemSchema.nullable().optional(),
    linkedItems: WorkspaceAttachmentsSchema.optional(),
    linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
    comment: OptionalString,
    displayName: OptionalString,
    displayNameKind: z.enum(['generated', 'user']).optional(),
    telemetrySource: RpcUnknown.transform((value) => {
      const parsed = workspaceSourceSchema.safeParse(value)
      return parsed.success ? parsed.data : undefined
    }).optional(),
    workspaceStatus: OptionalString,
    manualOrder: OptionalFiniteNumber,
    // Why: the client's "Nest Workspaces" choice; absent (older clients) keeps the host's own setting.
    nestWorkspaces: RpcOptionalBoolean,
    // Why: the client's Keep Local Main Up to Date choice; absent (older clients) keeps the host's.
    refreshLocalBaseRefOnWorktreeCreate: RpcOptionalBoolean,
    localBaseRefSuggestionDismissed: RpcOptionalBoolean,
    sparseCheckout: z
      .object({
        directories: z.array(RpcString),
        presetId: OptionalString
      })
      .optional(),
    pushTarget: z
      .object({
        remoteName: RpcString,
        branchName: RpcString,
        remoteUrl: OptionalString
      })
      .optional(),
    runHooks: OptionalBoolean,
    activate: OptionalBoolean,
    // Paired desktop/web defaults to caller navigation with no activation event; reveal from the result’s setup/startup/defaultTabs.
    // Explicit targets opt into all-surface reveal.
    navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional(),
    parentWorkspace: OptionalString,
    // App-selected parents are manual; absent retains older clients’ CLI provenance.
    parentWorkspaceOrigin: z.literal('manual').optional(),
    envParentWorkspace: OptionalString,
    parentWorktree: OptionalString,
    cwdParentWorktree: OptionalString,
    noParent: OptionalBoolean,
    callerTerminalHandle: OptionalString,
    orchestrationContext: z
      .object({
        parentWorktreeId: OptionalString,
        orchestrationRunId: OptionalString,
        taskId: OptionalString,
        coordinatorHandle: OptionalString
      })
      .optional(),
    setupOnly: RpcOptionalBoolean,
    setupDecision: RpcUnknown.transform((v) =>
      typeof v === 'string' && (v === 'run' || v === 'skip' || v === 'inherit') ? v : undefined
    )
      .pipe(z.union([z.enum(['run', 'skip', 'inherit']), RpcUndefined]))
      .optional(),
    // Desktop can prequote startup commands; clients unable to quote for the host send startupAgent.
    startupCommand: OptionalString,
    startupEnv: z.record(RpcString, RpcString).optional(),
    startupLaunchConfig: sleepingAgentLaunchConfigSchema,
    startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
    // Quote agent launches on the execution host because SSH shells can differ from the client’s.
    startupAgent: OptionalTuiAgent,
    startupPrompt: OptionalString,
    // Which surface asked for the agent the host launches from `startupAgent` or `startupDraft`.
    launchSource: LaunchSourceParam.optional(),
    // Task-driven mobile creation uses desktop-equivalent host defaults and linked issue/PR draft URLs.
    startupDraft: OptionalString,
    createdWithAgent: RpcUnknown.transform((value) =>
      isTuiAgent(value) ? value : undefined
    ).optional(),
    // Reuse the mutation key after connection migration so retries cannot create duplicate worktrees.
    clientMutationId: RpcString.min(1).max(128).optional(),
    /** The requesting window's pending creation, so the host's in-progress entry shares its id. */
    creationId: RpcString.min(1).max(128).optional(),
    automationProvenanceRequest: AutomationWorkspaceProvenanceRequest.optional(),
    cliProvenanceRequest: CliWorkspaceProvenanceRequest.optional()
  })
  .superRefine((params, ctx) => {
    assertLinkedWorkItemSourceContextMatch(params, ctx)
    if ((params.parentWorkspace || params.parentWorktree) && params.noParent === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose either one parent selector or --no-parent.'
      })
    }
    if (params.parentWorkspace && params.parentWorktree) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose either one parent selector or --no-parent.'
      })
    }
    if (params.startupPrompt !== undefined && params.startupAgent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startupPrompt requires startupAgent'
      })
    }
  })

export const WorktreePrefetchCreateBase = z.object({
  repo: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing repo selector')
  ),
  baseBranch: OptionalString
})
