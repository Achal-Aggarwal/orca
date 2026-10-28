import { RpcNumber, RpcString } from './rpc-value-schemas'
import { Identifier, SessionId } from './structured-agent-session-identifiers'
import { z } from 'zod'

export const MutationEnvelope = z
  .object({
    sessionId: SessionId,
    clientOperationId: Identifier('Invalid client operation id'),
    /** Null is the "must not exist yet" case; every other call fences. */
    expectedRuntimeFence: RpcNumber.int().positive().nullable(),
    payloadFingerprint: RpcString.regex(
      /^[0-9a-f]{64}$/,
      'Payload fingerprint must be a sha256 hex digest'
    )
  })
  .strict()
