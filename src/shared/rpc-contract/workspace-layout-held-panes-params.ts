import { RpcNonemptyString } from './rpc-value-schemas'
// Paired reopen uses server-owned IDs; requires LAYOUT_REOPEN_HELD_PANES_CAPABILITY.
import { z } from 'zod'

export const LayoutReopenHeldPanesParams = z.object({
  panes: z
    .array(
      z.object({
        worktreeId: RpcNonemptyString,
        tabId: RpcNonemptyString,
        leafId: RpcNonemptyString
      })
    )
    .min(1)
    .max(1000)
})
