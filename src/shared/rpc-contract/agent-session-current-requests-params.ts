import { RpcString, RpcOptionalNonnegativeInteger } from './rpc-value-schemas'
import { z } from 'zod'
import { SessionId } from './structured-agent-session-identifiers'

export const CurrentRequestsParams = z
  .object({
    sessionId: SessionId,
    version: RpcString.uuid(),
    cursor: RpcOptionalNonnegativeInteger
  })
  .strict()
