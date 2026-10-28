import {
  RpcNull,
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcString,
  RpcUnknown,
  RpcNonemptyString,
  RpcOptionalNonemptyString,
  RpcOptionalNonnegativeInteger
} from './rpc-value-schemas'
import { z } from 'zod'
import { RUNTIME_NAVIGATION_TARGETS } from '../runtime-navigation'
import { TAB_ACTIVATION_INTENTS } from '../tab-activation-intent'
import { OptionalBoolean } from './rpc-param-primitives'
import { sleepingAgentLaunchConfigSchema } from '../workspace-session-sleeping-agents'
import type { TuiAgent } from '../tui-agent'
import { isTuiAgent } from '../tui-agent-config'
import { LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH } from '../terminal-quick-command-prompt-limit'
import { ResumeProviderSessionParam, WindowsShellOverrideParam } from './terminal-unary-params'

export const WorktreeTabSelector = z.object({
  worktree: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing worktree selector')
  )
})

export const SessionTabsUnsubscribe = WorktreeTabSelector.extend({
  subscriptionId: RpcOptionalNonemptyString
})

export const ActivateTab = WorktreeTabSelector.extend({
  tabId: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing tab id')
  ),
  leafId: RpcString.max(128).optional(),
  notifyClients: OptionalBoolean,
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional(),
  // Absent means user intent for old clients; only automatic activation may refuse a slept pane.
  intent: z.enum(TAB_ACTIVATION_INTENTS).optional()
})

export const CloseTab = ActivateTab.extend({
  // Absent preserves legacy user closes; lifecycle intent uses the evidence-bearing method.
  // Send replay only with SESSION_TAB_CLOSE_REPLAY_REASON_RUNTIME_CAPABILITY after reconnect.
  reason: z.enum(['user', 'replay']).optional(),
  // Confirmed pinned-tab close; gate on SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY because old hosts strip and refuse.
  force: z.literal(true).optional()
})

export const CloseLifecycleTab = ActivateTab.extend({
  reason: z.enum(['pty-exit', 'cleanup']),
  publicationEpoch: RpcString.min(1).max(128),
  terminal: RpcString.min(1).max(256)
})

export type TerminalPaneLayoutNodeInput =
  | { type: 'leaf'; leafId: string }
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      first: TerminalPaneLayoutNodeInput
      second: TerminalPaneLayoutNodeInput
      ratio?: number
    }

// Cap depth/node count iteratively before building: recursive parsing of untrusted layout trees can overflow main’s stack.
export const MAX_PANE_LAYOUT_DEPTH = 64

export const MAX_PANE_LAYOUT_NODES = 1024

export function parseTerminalPaneLayoutNode(value: unknown): TerminalPaneLayoutNodeInput | null {
  let nodeCount = 0
  const stack: { raw: unknown; depth: number }[] = [{ raw: value, depth: 0 }]
  while (stack.length > 0) {
    const { raw, depth } = stack.pop()!
    if (depth > MAX_PANE_LAYOUT_DEPTH || ++nodeCount > MAX_PANE_LAYOUT_NODES) {
      return null
    }
    if (typeof raw !== 'object' || raw === null) {
      return null
    }
    const node = raw as Record<string, unknown>
    if (node.type === 'leaf') {
      if (typeof node.leafId !== 'string' || node.leafId.length < 1 || node.leafId.length > 128) {
        return null
      }
      continue
    }
    if (node.type === 'split') {
      if (node.direction !== 'horizontal' && node.direction !== 'vertical') {
        return null
      }
      if (
        node.ratio !== undefined &&
        (typeof node.ratio !== 'number' ||
          !Number.isFinite(node.ratio) ||
          node.ratio < 0 ||
          node.ratio > 1)
      ) {
        return null
      }
      stack.push({ raw: node.first, depth: depth + 1 }, { raw: node.second, depth: depth + 1 })
      continue
    }
    return null
  }
  return value as TerminalPaneLayoutNodeInput
}

export const TerminalPaneLayoutNodeSchema = RpcUnknown.transform((value) =>
  parseTerminalPaneLayoutNode(value)
).pipe(
  z.custom<TerminalPaneLayoutNodeInput>((value) => value !== null, {
    message: 'Invalid or too-deep pane layout tree'
  })
)

export const UpdatePaneLayout = WorktreeTabSelector.extend({
  tabId: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing tab id')
  ),
  root: z.union([RpcNull, TerminalPaneLayoutNodeSchema]),
  expandedLeafId: RpcString.max(128).nullable().optional(),
  chatLeafId: RpcString.max(128).nullable().optional(),
  titlesByLeafId: z.record(RpcString, RpcString).optional(),
  // Only these leaves were renamed; other titles are resends. Older gesture intent is stripped unread.
  renamedLeafIds: z.array(RpcString.max(128)).max(64).optional().catch(undefined)
})

const MovePaneId = RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
  RpcString.min(1).max(512)
)

export const MovePaneToNewTab = WorktreeTabSelector.extend({
  sourceTabId: MovePaneId,
  targetTabId: MovePaneId,
  leafId: MovePaneId,
  // Where the client dropped the new tab; without it the host appends the tab.
  targetGroupId: RpcString.min(1).max(512).optional(),
  index: RpcNumber.int().min(0).optional()
})
export const SetTabProps = WorktreeTabSelector.extend({
  tabId: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing tab id')
  ),
  // undefined = leave unchanged; null = clear color / unset.
  color: RpcString.max(64).nullable().optional(),
  isPinned: RpcOptionalBoolean,
  // undefined = leave unchanged; no "clear" semantic (absence means default 'terminal').
  viewMode: z.enum(['terminal', 'chat']).optional(),
  // A terminal tab's manual name; null clears it. Older hosts strip it and change nothing.
  customTitle: RpcString.max(512).nullable().optional()
})

export const CreateTerminalTab = WorktreeTabSelector.extend({
  sourceChatFork: z.object({ sessionId: RpcNonemptyString }).strict().optional(),
  afterTabId: RpcOptionalString,
  targetGroupId: RpcOptionalString,
  command: RpcOptionalString,
  // Why: the shell the terminal IS; a shell sent as `command` runs nested in the host default.
  shell: WindowsShellOverrideParam.optional(),
  cwd: RpcOptionalNonemptyString,
  env: z.record(RpcString, RpcString).optional(),
  envToDelete: z.array(RpcString.min(1).max(256)).max(32).optional(),
  startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
  launchConfig: sleepingAgentLaunchConfigSchema,
  launchToken: RpcString.min(1).max(128).optional(),
  // Record the resumed conversation before hook reports; drop malformed hints, never the create (#10923).
  resumeProviderSession: ResumeProviderSessionParam.optional().catch(undefined),
  agent: z
    .custom<TuiAgent>(isTuiAgent, {
      message: 'Unknown agent preset'
    })
    .optional(),
  // Legacy phones without agent.launch need host-shell quoting and TUI-ready prompt injection; quick commands retain the legacy cap.
  agentPrompt: RpcString.max(LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH)
    .refine((value) => value.trim().length > 0, { message: 'Agent prompt cannot be empty' })
    .optional(),
  // agent is the legacy preset; launchAgent preserves launch-plan identity/config across runtime boundaries.
  launchAgent: z
    .custom<TuiAgent>(isTuiAgent, {
      message: 'Unknown launch agent'
    })
    .optional(),
  viewMode: z.enum(['terminal', 'chat']).optional(),
  activate: RpcOptionalBoolean,
  select: RpcOptionalBoolean,
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional(),
  // Retry the same in-flight create on double-tap/reconnect instead of spawning another terminal.
  clientMutationId: RpcString.min(1).max(128).optional()
}).superRefine((value, context) => {
  if (value.sourceChatFork) {
    if (!value.clientMutationId) {
      context.addIssue({
        code: 'custom',
        path: ['clientMutationId'],
        message: 'A fork needs a mutation id'
      })
    }
    for (const field of [
      'command',
      'shell',
      'agent',
      'agentPrompt',
      'env',
      'envToDelete',
      'cwd',
      'launchConfig',
      'launchToken',
      'resumeProviderSession',
      'launchAgent',
      'startupCommandDelivery',
      'viewMode'
    ] as const) {
      if (value[field] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'A fork uses host launch settings'
        })
      }
    }
  }
  if (value.agentPrompt !== undefined && value.agent === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['agentPrompt'],
      message: 'Agent prompt requires an agent preset'
    })
  }
  if (value.agentPrompt !== undefined && value.command !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['agentPrompt'],
      message: 'Agent prompt cannot be combined with a startup command'
    })
  }
  // Why: agent launches plan their own shell, which would silently replace the pick.
  if (value.shell !== undefined && (value.agent || value.launchAgent || value.launchConfig)) {
    context.addIssue({
      code: 'custom',
      path: ['shell'],
      message: 'A shell pick cannot be combined with an agent launch'
    })
  }
})

export const MoveTabBase = {
  worktree: WorktreeTabSelector.shape.worktree,
  tabId: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing tab id')
  ),
  targetGroupId: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing target group id')
  )
} as const

export const MoveTab = z.discriminatedUnion('kind', [
  z
    .object({
      ...MoveTabBase,
      kind: z.literal('reorder'),
      tabOrder: z.array(RpcNonemptyString).min(1, 'Missing tab order')
    })
    .strict(),
  z
    .object({
      ...MoveTabBase,
      kind: z.literal('move-to-group'),
      index: RpcOptionalNonnegativeInteger
    })
    .strict(),
  z
    .object({
      ...MoveTabBase,
      kind: z.literal('split'),
      splitDirection: z.enum(['left', 'right', 'up', 'down'])
    })
    .strict()
])

export const SaveMarkdownTab = ActivateTab.extend({
  baseVersion: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing base version')
  ),
  content: RpcString
})
