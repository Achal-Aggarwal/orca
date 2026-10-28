import {
  ScalarNonnegativeInteger,
  ScalarNumber,
  ScalarPositiveInteger,
  ScalarString
} from './scalar-value-schemas'
import { z } from 'zod'

const EpochMsSchema = ScalarNonnegativeInteger.max(Number.MAX_SAFE_INTEGER)

export const RelayPhoneHelloSchema = z.union([
  z
    .object({
      type: z.literal('relay-hello'),
      ok: z.literal(false),
      code: ScalarNumber.int().min(4000).max(4999)
    })
    .strict(),
  z
    .object({
      type: z.literal('relay-hello'),
      ok: z.literal(true),
      credentialKind: z.literal('invite'),
      leaseExpiresAt: EpochMsSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('relay-hello'),
      ok: z.literal(true),
      credentialKind: z.literal('resume'),
      leaseExpiresAt: EpochMsSchema,
      acceptedCredentialVersion: ScalarPositiveInteger,
      acceptedAs: z.enum(['current', 'grace']),
      resumeExpiresAt: EpochMsSchema,
      graceExpiresAt: EpochMsSchema.optional()
    })
    .strict()
])

export type RelayPhoneHello = z.infer<typeof RelayPhoneHelloSchema>

export const RelayMovedSchema = z
  .object({
    type: z.literal('relay-moved'),
    v: z.literal(1),
    cellUrl: ScalarString.refine((value) => {
      try {
        const parsed = new URL(value)
        return parsed.protocol === 'https:' && parsed.origin === value
      } catch {
        return false
      }
    }),
    assignmentEpoch: ScalarNonnegativeInteger.max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
