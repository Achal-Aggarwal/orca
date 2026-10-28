import { RpcNull, RpcString } from './rpc-value-schemas'
import { z } from 'zod'

/** Agent-generated titles for many tabs, of any workspaces: main renames them in one write. */
export const RenameTabsCommand = z.object({
  type: z.literal('renameTabs'),
  kind: z.literal('generated'),
  renames: z
    .array(
      z.object({
        workspace: RpcString.min(1),
        tabId: RpcString.min(1),
        title: z.union([RpcString, RpcNull]),
        replaceExisting: z.literal(true).optional()
      })
    )
    .min(1)
})
