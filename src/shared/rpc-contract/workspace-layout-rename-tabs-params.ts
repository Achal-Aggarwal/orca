import { RpcNull, RpcString, RpcNonemptyString } from './rpc-value-schemas'
import { z } from 'zod'

/** Agent-generated titles for many tabs, of any workspaces: main renames them in one write. */
export const RenameTabsCommand = z.object({
  type: z.literal('renameTabs'),
  kind: z.literal('generated'),
  renames: z
    .array(
      z.object({
        workspace: RpcNonemptyString,
        tabId: RpcNonemptyString,
        title: z.union([RpcString, RpcNull]),
        replaceExisting: z.literal(true).optional()
      })
    )
    .min(1)
})
