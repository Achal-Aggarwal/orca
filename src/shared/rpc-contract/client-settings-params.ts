import {
  RpcBoolean,
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcString,
  RpcUnknown
} from './rpc-value-schemas'
import { z } from 'zod'
import { isTaskProvider } from '../task-providers'
import type { TaskProvider } from '../task-providers'
import { isTuiAgent } from '../tui-agent-config'
import { normalizeDisabledTuiAgents } from '../tui-agent-selection'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../tui-agent-launch-defaults'
import { MACHINE_NAME_MAX_LENGTH } from '../machine-name'
import { normalizePRBotAuthorOverrides } from '../pr-bot-author-overrides'
import { WorktreeVisibilityDefaultsUpdate } from './worktree-visibility-defaults-params'
import { AGENT_CHAT_PERMISSION_MODES } from '../agent-chat-permission-mode'

export const TaskProviderParam = z.custom<TaskProvider>(isTaskProvider, {
  message: 'Unknown task provider'
})

export const PRBotAuthorOverrideUpdate = z.object({ author: RpcString, isBot: RpcBoolean }).strict()

export const NativeChatSessionOptionPickBase = {
  modelId: RpcString.trim().min(1).max(512),
  adoptModelAsLaunchDefault: RpcOptionalBoolean
}

export const NativeChatSessionOptionPick = z.union([
  z
    .object({
      ...NativeChatSessionOptionPickBase,
      optionId: z.enum(['model', 'effort', 'serviceTier']),
      value: RpcString.trim().min(1).max(512)
    })
    .strict(),
  z
    .object({
      ...NativeChatSessionOptionPickBase,
      optionId: z.enum(['fastMode', 'thinking']),
      value: RpcBoolean
    })
    .strict()
])

// Any agent Orca launches: picks are keyed by agent id, and every native chat agent remembers them.
const NativeChatSessionOptionAgent = RpcString.refine(isTuiAgent, { message: 'Unknown agent' })

export const NativeChatSessionOptionsMutation = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('apply-picks'),
      agent: NativeChatSessionOptionAgent,
      picks: z.array(NativeChatSessionOptionPick).min(1).max(8)
    })
    .strict(),
  z
    .object({
      type: z.literal('clear-model-if-missing'),
      agent: NativeChatSessionOptionAgent,
      availableModelIds: z.array(RpcString.trim().min(1).max(512)).min(1).max(256)
    })
    .strict()
])

export const GitHubProjectRef = z
  .object({
    owner: RpcString,
    ownerType: z.enum(['organization', 'user']),
    number: RpcNumber.int(),
    host: RpcOptionalString
  })
  .strict()

export const GitHubProjectSettings = z
  .object({
    pinned: z.array(GitHubProjectRef),
    recent: z.array(
      GitHubProjectRef.extend({
        lastOpenedAt: RpcString
      }).strict()
    ),
    lastViewByProject: z.record(RpcString, z.object({ viewId: RpcString }).strict()),
    activeProject: GitHubProjectRef.nullable()
  })
  .strict()

export const SettingsUpdate = z
  .object({
    machineName: RpcString.trim().max(MACHINE_NAME_MAX_LENGTH).optional(),
    worktreeVisibilityDefaults: WorktreeVisibilityDefaultsUpdate.optional(),
    defaultTuiAgent: RpcUnknown.transform((value) =>
      value === null || value === 'blank' || isTuiAgent(value) ? value : undefined
    ).optional(),
    disabledTuiAgents: RpcUnknown.transform((value) =>
      normalizeDisabledTuiAgents(value)
    ).optional(),
    agentDefaultArgs: RpcUnknown.transform((value) =>
      normalizeTuiAgentArgsRecord(value)
    ).optional(),
    agentDefaultEnv: RpcUnknown.transform((value) => normalizeTuiAgentEnvRecord(value)).optional(),
    defaultTaskSource: TaskProviderParam.optional(),
    visibleTaskProviders: z.array(TaskProviderParam).optional(),
    defaultTaskViewPreset: z
      .enum(['issues', 'my-issues', 'prs', 'my-prs', 'review', 'all'])
      .optional(),
    experimentalNewWorktreeCardStyle: RpcOptionalBoolean,
    /** No UI: the host-side switch for connectors, so a headless server can be turned on. */
    experimentalConnectors: RpcOptionalBoolean,
    agentStatusHooksEnabled: RpcOptionalBoolean,
    claudeSubagentNavigationEnabled: RpcOptionalBoolean,
    defaultRepoSelection: z.array(RpcString).nullable().optional(),
    defaultLinearTeamSelection: z.array(RpcString).nullable().optional(),
    compactWorktreeCards: RpcOptionalBoolean,
    minimaxGroupId: RpcOptionalString,
    minimaxUsageModels: RpcOptionalString,
    minimaxEndpoint: z.enum(['overseas', 'cn']).optional(),
    zcodePlanSite: z.enum(['zai', 'bigmodel']).optional(),
    githubProjects: GitHubProjectSettings.optional(),
    prBotAuthorOverrides: RpcUnknown.transform((value) =>
      normalizePRBotAuthorOverrides(value)
    ).optional(),
    nativeChatPermissionMode: z.enum(AGENT_CHAT_PERMISSION_MODES).optional()
  })
  .strict()
  .default({})
