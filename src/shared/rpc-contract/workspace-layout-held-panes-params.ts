import { RpcString } from './rpc-value-schemas'
// Paired reopen uses server-owned IDs; requires LAYOUT_REOPEN_HELD_PANES_CAPABILITY.
import { z } from 'zod'

export const LayoutReopenHeldPanesParams = z.object({
  panes: z
    .array(
      z.object({
        worktreeId: RpcString.min(1),
        tabId: RpcString.min(1),
        leafId: RpcString.min(1)
      })
    )
    .min(1)
    .max(1000)
})
