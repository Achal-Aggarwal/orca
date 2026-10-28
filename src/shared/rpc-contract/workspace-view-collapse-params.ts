import { RpcBoolean, RpcNumber, RpcString } from './rpc-value-schemas'
import { z } from 'zod'

/** Retry with the same opId; seq grows per writer. Mint a new writer when resetting its counter,
 * or the host will treat new changes as already settled. */
export const SetCollapsedParams = z.object({
  key: RpcString.min(1).max(1024),
  collapsed: RpcBoolean,
  opId: z.object({
    writer: RpcString.min(1).max(128),
    seq: RpcNumber.int().nonnegative()
  })
})

export type SetCollapsedRequest = z.infer<typeof SetCollapsedParams>

/** `applied: false` settles the op too: it already ran, or the same writer changed the key since. */
export type SetCollapsedResult = { collapsed: boolean; applied: boolean }
