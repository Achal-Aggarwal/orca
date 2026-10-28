import { RpcNumber, RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import { isTerminalLeafId } from '../stable-pane-id'
import { isValidHostTerminalTabId } from '../terminal-tab-id'
import type { TuiAgent } from '../tui-agent'
import { isTuiAgent } from '../tui-agent-config'

const workspace = RpcString.min(1)

/** An open into a new group, named by the command's groupId, beside this one (NewGroupSplit). */
export const NewGroupSplit = z
  .object({
    besideGroupId: RpcString.min(1),
    besideLastGroupId: RpcString.min(1).optional(),
    direction: z.enum(['left', 'right', 'up', 'down'])
  })
  .optional()

const TerminalCreation = z.object({
  defaultTitle: RpcString.min(1).optional(),
  shellOverride: RpcString.min(1).optional(),
  startupCwd: RpcString.min(1).optional(),
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
  groupId: RpcString.min(1).optional(),
  viewMode: z.enum(['terminal', 'chat']).optional(),
  createdAt: RpcNumber.int().nonnegative().optional(),
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
      color: RpcString.min(1).optional(),
      creation: TerminalCreation.optional()
    })
  )
})
