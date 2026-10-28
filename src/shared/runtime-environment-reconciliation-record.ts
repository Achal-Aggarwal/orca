import { ScalarFiniteNumber, ScalarNonemptyString, ScalarString } from './scalar-value-schemas'
import { z } from 'zod'

export const RuntimeEnvironmentReconciliationRecordSchema = z.object({
  version: z.literal(1),
  stage: z.enum(['prepared', 'catalog-active']),
  requestId: ScalarNonemptyString,
  canonicalEnvironmentId: ScalarNonemptyString,
  runtimeId: ScalarNonemptyString,
  preparedAt: ScalarFiniteNumber,
  registrations: z
    .array(
      z.object({
        environmentId: ScalarNonemptyString,
        authorityDigest: ScalarString.regex(/^[a-f0-9]{64}$/)
      })
    )
    .length(2)
})

export type RuntimeEnvironmentReconciliationRecord = z.infer<
  typeof RuntimeEnvironmentReconciliationRecordSchema
>

export function assertRuntimeEnvironmentNotReconciling(environment: {
  reconciliation?: unknown
}): void {
  if (environment.reconciliation) {
    throw new Error('Finish or cancel host reconciliation before changing this server lifecycle.')
  }
}
