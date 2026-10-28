import {
  ScalarNonemptyString,
  ScalarNonnegativeInteger,
  ScalarNumber,
  ScalarOptionalFiniteNumber,
  ScalarOptionalPositiveInteger
} from '../../../../../shared/scalar-value-schemas'
import { z } from 'zod'
import { requiredString } from '../../../../../shared/rpc-contract/rpc-param-primitives'
import { TerminalViewport } from '../../../../../shared/rpc-contract/terminal-unary-params'
import { TerminalHandle } from '../../../../../shared/rpc-contract/terminal-stream-params'

export const TerminalMultiplexSubscribeFrame = TerminalHandle.extend({
  streamId: ScalarNumber.int().min(1),
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop')
    })
    .optional(),
  viewport: TerminalViewport.optional(),
  capabilities: z
    .object({
      ackOutput: z.literal(1).optional(),
      ackOutputSourceRanges: z.literal(1).optional(),
      desktopViewportClaims: z.literal(1).optional(),
      outputPause: z.literal(1).optional(),
      outputPauseDropNotice: z.literal(1).optional(),
      writeUnavailable: z.literal(1).optional(),
      // Old clients quarantine input after writeUnavailable; send host-lost semantics only to clients that understand them.
      endpointLossNotice: z.literal(1).optional(),
      inputAck: z.literal(1).optional()
    })
    .optional(),
  // Name the client input sequence domain across stream replacement so replay deduplicates.
  inputSessionId: ScalarNonemptyString.max(128).optional()
})

export const TerminalMultiplexLegacyAckFrame = z
  .object({
    bytes: ScalarNonnegativeInteger
  })
  .strict()

export const TerminalMultiplexSnapshotRequestFrame = z.object({
  requestId: ScalarOptionalPositiveInteger,
  scrollbackRows: ScalarOptionalFiniteNumber
})
