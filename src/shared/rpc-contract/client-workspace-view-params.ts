import { RpcNumber, RpcString } from './rpc-value-schemas'
import { z } from 'zod'

/** Replace the client’s visible workspace/tab report on each owning host; empty means hidden or unfocused. */
export const ClientWorkspaceViewParams = z.object({
  workspaceIds: z.array(RpcString.min(1).max(1024)).max(64),
  tabIds: z.array(RpcString.min(1).max(1024)).max(256),
  /** How long the user stays present without new input; null where presence is not tracked. */
  presentForMs: RpcNumber.int().nonnegative().nullable()
})

export type ClientWorkspaceView = z.infer<typeof ClientWorkspaceViewParams>
