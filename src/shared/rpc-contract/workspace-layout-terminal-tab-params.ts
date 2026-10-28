import {
  RpcString,
  RpcNonemptyString,
  RpcOptionalNonemptyString,
  RpcOptionalNonnegativeInteger
} from './rpc-value-schemas'
import { z } from 'zod'
import { isTerminalLeafId } from '../stable-pane-id'
import { isValidHostTerminalTabId } from '../terminal-tab-id'
import type { TuiAgent } from '../tui-agent'
import { isTuiAgent } from '../tui-agent-config'

const workspace = RpcNonemptyString

/** An open into a new group, named by the command's groupId, beside this one (NewGroupSplit). */
export const NewGroupSplit = z
  .object({
    besideGroupId: RpcNonemptyString,
    besideLastGroupId: RpcOptionalNonemptyString,
    direction: z.enum(['left', 'right', 'up', 'down'])
  })
  .optional()

const TerminalCreation = z.object({
  defaultTitle: RpcOptionalNonemptyString,
  shellOverride: RpcOptionalNonemptyString,
  startupCwd: RpcOptionalNonemptyString,
  forceHostRuntime: z.literal(true).optional(),
  launchAgent: z
    .custom<TuiAgent>((value) => typeof value === 'string' && isTuiAgent(value))
    .optional()
})

/** Preserve window-created tab/pane IDs for immediate callers; refuse collisions and replay creates idempotently. */
export const CreateTerminalTabCommand = z.object({
  type: z.literal('createTerminalTab'),
  workspace,
  tabId: RpcString.refine(isValidHostTerminalTabId),
  leafId: RpcString.refine(isTerminalLeafId),
  groupId: RpcOptionalNonemptyString,
  viewMode: z.enum(['terminal', 'chat']).optional(),
  createdAt: RpcOptionalNonnegativeInteger,
  quickCommandLabel: RpcString.trim().min(1).optional(),
  creation: TerminalCreation.optional(),
  /** Only into a workspace with no tab in main's copy; otherwise nothing is created. */
  initial: z.literal('activation').optional(),
  split: NewGroupSplit
})

/** Apply ordered defaults under window-proposed IDs only before the workspace is marked; reject collisions. */
export const ApplyDefaultTabsCommand = z.object({
  type: z.literal('applyDefaultTabs'),
  workspace,
  tabs: z.array(
    z.object({
      tabId: RpcString.refine(isValidHostTerminalTabId),
      leafId: RpcString.refine(isTerminalLeafId),
      title: RpcString.trim().min(1).optional(),
      color: RpcOptionalNonemptyString,
      creation: TerminalCreation.optional()
    })
  )
})
