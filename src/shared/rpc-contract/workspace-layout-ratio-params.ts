import { RpcNumber, RpcString, RpcNonemptyString } from './rpc-value-schemas'
import { z } from 'zod'
import { TerminalPaneLayoutNodeSchema } from './session-tabs-schemas-params'
import { TerminalOrphanGroupLayout } from './terminal-orphan-params'

/** Divider ratios, each the split it moved by path from the root ("first.second"; "" the root). */
const SplitRatioIntents = z
  .array(
    z.object({
      path: RpcString.regex(/^((first|second)(\.(first|second))*)?$/),
      ratio: RpcNumber.gt(0).lt(1),
      // The split the window means: its direction and the first pane or group on each side.
      split: z
        .object({
          direction: z.enum(['horizontal', 'vertical']),
          first: RpcNonemptyString,
          second: RpcNonemptyString
        })
        .optional()
    })
  )
  .min(1)

/** Use ratios, or legacy root trees; main refuses either if pane identities differ. */
export const SetPaneRatiosCommand = z
  .object({
    type: z.literal('setPaneRatios'),
    workspace: RpcNonemptyString,
    tabId: RpcNonemptyString,
    root: TerminalPaneLayoutNodeSchema.optional(),
    ratios: SplitRatioIntents.optional()
  })
  .refine((command) => (command.root === undefined) !== (command.ratios === undefined))

/** As SetPaneRatiosCommand, for the workspace's group splits (`groupLayout`: the older form). */
export const SetGroupRatiosCommand = z
  .object({
    type: z.literal('setGroupRatios'),
    workspace: RpcNonemptyString,
    groupLayout: TerminalOrphanGroupLayout.optional(),
    ratios: SplitRatioIntents.optional()
  })
  .refine((command) => (command.groupLayout === undefined) !== (command.ratios === undefined))
