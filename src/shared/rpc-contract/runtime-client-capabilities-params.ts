import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'

export const ClientCapabilitiesUpdate = z
  .object({
    clientCapabilities: z.array(RpcString.min(1).max(128)).max(64)
  })
  .strict()
