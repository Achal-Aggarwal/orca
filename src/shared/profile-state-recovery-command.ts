import {
  ScalarNonemptyString,
  ScalarOptionalString,
  ScalarPositiveInteger,
  ScalarString
} from './scalar-value-schemas'
import { z } from 'zod'

export const PROFILE_STATE_RECOVERY_FLAG = '--profile-state-recovery'
export const PROFILE_STATE_RECOVERY_RESULT_PREFIX = '[profile-state-recovery] '
/** Desktop variant: applies a startup-dialog choice, then relaunches Orca normally. */
export const PROFILE_STATE_DESKTOP_RECOVERY_FLAG = '--profile-state-desktop-recovery'

const positiveInteger = ScalarPositiveInteger.max(Number.MAX_SAFE_INTEGER)
const repairSectionSchema = z
  .object({ domain: ScalarString, backupId: ScalarNonemptyString.nullable() })
  .strict()
const selectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json'), revision: positiveInteger }).strict(),
  z.object({ kind: z.literal('current-json') }).strict(),
  z.object({ kind: z.literal('current-sqlite') }).strict(),
  z.object({ kind: z.literal('latest-json') }).strict(),
  z.object({ kind: z.literal('sqlite'), backupId: ScalarNonemptyString }).strict(),
  // Sections: the plan the user approved; omitted, the CLI repairs whatever it finds.
  z
    .object({ kind: z.literal('repair'), sections: z.array(repairSectionSchema).optional() })
    .strict()
])

export const profileStateRecoveryRequestSchema = z
  .object({
    userDataPath: ScalarNonemptyString,
    selector: selectorSchema,
    profileId: ScalarString.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).optional()
  })
  .strict()

const exportsSchema = z.object({
  profileId: ScalarString,
  dataFile: ScalarString,
  databaseFile: ScalarString,
  exportPaths: z.array(ScalarString).readonly(),
  backups: z
    .array(z.object({ id: ScalarString, path: ScalarString, createdAtMs: positiveInteger }))
    .readonly()
})
const rollbackSchema = exportsSchema.extend({
  // Canonical JSON edited outside SQLite has no database revision.
  revision: positiveInteger.nullable(),
  quarantineDirectory: ScalarString,
  removedDatabaseFiles: z.array(ScalarString).readonly(),
  storage: z.enum(['json', 'sqlite']),
  restoredPath: ScalarString,
  backupId: ScalarOptionalString,
  repairedSections: z
    .array(repairSectionSchema.extend({ backupCreatedAtMs: positiveInteger.optional() }))
    .readonly()
    .optional()
})

export const profileStateRecoveryResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: rollbackSchema }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['invalid_argument', 'runtime_error']),
    message: ScalarString
  })
])

export type ProfileStateRecoverySelector = z.infer<typeof selectorSchema>
export type ProfileStateRecoveryRepairSection = z.infer<typeof repairSectionSchema>
export type ProfileStateRecoveryRequest = z.infer<typeof profileStateRecoveryRequestSchema>
export type ProfileStateRecoveryResponse = z.infer<typeof profileStateRecoveryResponseSchema>
export type ProfileStateExportsResult = z.infer<typeof exportsSchema>
export type ProfileStateRollbackResult = z.infer<typeof rollbackSchema>

export class ProfileStateRecoveryCommandError extends Error {
  constructor(
    readonly code: 'invalid_argument' | 'runtime_error',
    message: string
  ) {
    super(message)
    this.name = 'ProfileStateRecoveryCommandError'
  }
}

export function isProfileStateRecoveryCommandError(
  error: unknown
): error is Error & { code: 'invalid_argument' | 'runtime_error' } {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'invalid_argument' || error.code === 'runtime_error')
  )
}
