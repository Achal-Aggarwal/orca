import {
  ScalarNull,
  ScalarNumber,
  ScalarOptionalString,
  ScalarOptionalUnknown,
  ScalarString
} from '../../shared/scalar-value-schemas'
import { z } from 'zod'
import { AcpAgentError, AcpInvalidResponseError } from './acp-errors'

const idSchema = z.union([ScalarString, ScalarNumber, ScalarNull])
const errorSchema = z.object({
  code: ScalarNumber.int(),
  message: ScalarString,
  data: ScalarOptionalUnknown
})
export const acpRpcEnvelopeSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: idSchema.optional(),
  method: ScalarOptionalString,
  params: ScalarOptionalUnknown,
  result: ScalarOptionalUnknown,
  error: ScalarOptionalUnknown
})
export type AcpJsonRpcMessage = z.infer<typeof acpRpcEnvelopeSchema>

export function invalidAcpResponseEnvelope(raw: unknown): () => Error {
  return () => new AcpInvalidResponseError('Invalid ACP response envelope', raw)
}

export function settleAcpResponse(
  frame: AcpJsonRpcMessage,
  pending: { resolve: (value: unknown) => void; reject: (error: Error) => void },
  diagnose: (message: string) => void
): void {
  if ('error' in frame) {
    const parsed = errorSchema.safeParse(frame.error)
    if (!parsed.success) {
      diagnose('Invalid ACP error response')
      pending.reject(new AcpInvalidResponseError('Invalid ACP error response', frame.error))
    } else {
      const error = parsed.data
      pending.reject(new AcpAgentError(error.code, error.message, error.data))
    }
  } else {
    pending.resolve(frame.result)
  }
}
