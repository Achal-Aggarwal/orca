import { RpcOptionalBoolean } from './rpc-value-schemas'
import { z } from 'zod'

export const UpdaterCheckParams = z.object({
  includePrerelease: RpcOptionalBoolean,
  includePerfPrerelease: RpcOptionalBoolean
})
