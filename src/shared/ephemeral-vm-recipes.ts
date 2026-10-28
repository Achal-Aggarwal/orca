import {
  ScalarNonemptyString,
  ScalarNumber,
  ScalarOptionalBoolean,
  ScalarOptionalNonemptyString,
  ScalarString
} from './scalar-value-schemas'
import { z } from 'zod'
import { parsePairingCode } from './pairing'
import { MAX_SSH_RELAY_GRACE_PERIOD_SECONDS, MIN_SSH_RELAY_GRACE_PERIOD_SECONDS } from './ssh-types'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
)

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const EPHEMERAL_VM_RECIPE_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 256 * 1024,
  nestingDepth: 64
} as const

const SavedPortForwardSchema = z
  .object({
    localPort: ScalarNumber.int().min(1).max(65535),
    remoteHost: ScalarNonemptyString,
    remotePort: ScalarNumber.int().min(1).max(65535),
    label: ScalarOptionalNonemptyString
  })
  .strict()

export const EphemeralVmRecipeSshTargetSchema = z
  .object({
    label: ScalarNonemptyString,
    configHost: ScalarOptionalNonemptyString,
    host: ScalarNonemptyString,
    port: ScalarNumber.int().min(1).max(65535),
    username: ScalarString,
    identityFile: ScalarOptionalNonemptyString,
    identityAgent: ScalarOptionalNonemptyString,
    identitiesOnly: ScalarOptionalBoolean,
    proxyCommand: ScalarOptionalNonemptyString,
    jumpHost: ScalarOptionalNonemptyString,
    relayGracePeriodSeconds: ScalarNumber.int()
      .refine(
        (value) =>
          value === 0 ||
          (value >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS &&
            value <= MAX_SSH_RELAY_GRACE_PERIOD_SECONDS),
        `Relay grace period must be 0 or between ${MIN_SSH_RELAY_GRACE_PERIOD_SECONDS} and ${MAX_SSH_RELAY_GRACE_PERIOD_SECONDS} seconds.`
      )
      .optional(),
    portForwards: z.array(SavedPortForwardSchema).optional()
  })
  .strict()

const EphemeralVmRecipeOrcaServerConnectionSchema = z
  .object({
    type: z.literal('orca-server'),
    pairingCode: ScalarNonemptyString,
    projectRoot: ScalarNonemptyString
  })
  .strict()

const EphemeralVmRecipeSshConnectionSchema = z
  .object({
    type: z.literal('ssh'),
    target: EphemeralVmRecipeSshTargetSchema,
    projectRoot: ScalarNonemptyString
  })
  .strict()

export const EphemeralVmRecipeConnectionSchema = z.discriminatedUnion('type', [
  EphemeralVmRecipeOrcaServerConnectionSchema,
  EphemeralVmRecipeSshConnectionSchema
])

export type EphemeralVmRecipeConnection = z.infer<typeof EphemeralVmRecipeConnectionSchema>

export const EphemeralVmRecipeLegacyResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    pairingCode: ScalarNonemptyString,
    projectRoot: ScalarNonemptyString,
    userData: z.record(ScalarString, JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeConnectionResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    connection: EphemeralVmRecipeConnectionSchema,
    userData: z.record(ScalarString, JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeProvisionedRootLegacyResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    checkoutMode: z.literal('provisioned-root'),
    pairingCode: ScalarNonemptyString,
    projectRoot: ScalarNonemptyString,
    userData: z.record(ScalarString, JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeProvisionedRootConnectionResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    checkoutMode: z.literal('provisioned-root'),
    connection: EphemeralVmRecipeConnectionSchema,
    userData: z.record(ScalarString, JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeResultSchema = z.union([
  EphemeralVmRecipeLegacyResultSchema,
  EphemeralVmRecipeConnectionResultSchema,
  EphemeralVmRecipeProvisionedRootLegacyResultSchema,
  EphemeralVmRecipeProvisionedRootConnectionResultSchema
])

export type EphemeralVmRecipeResult = z.infer<typeof EphemeralVmRecipeResultSchema>

export type EphemeralVmRecipeResultParseResult =
  | { ok: true; result: EphemeralVmRecipeResult }
  | { ok: false; error: string }

export type EphemeralVmRecipeDoctorCheckStatus = 'pass' | 'warn' | 'fail'

export type EphemeralVmRecipeDoctorCheck = {
  id: string
  status: EphemeralVmRecipeDoctorCheckStatus
  message: string
  remediation?: string
}

export type EphemeralVmRecipeDoctorResult = {
  recipeId: string
  repoPath: string
  ok: boolean
  checks: EphemeralVmRecipeDoctorCheck[]
}

export function parseEphemeralVmRecipeResult(stdout: string): EphemeralVmRecipeResultParseResult {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { ok: false, error: 'Recipe produced no JSON result.' }
  }
  let parsed: unknown
  try {
    assertJsonTextStructureWithinLimits(trimmed, EPHEMERAL_VM_RECIPE_JSON_STRUCTURE_LIMITS)
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'Recipe stdout must be one JSON object.' }
  }
  const result = EphemeralVmRecipeResultSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid recipe result.' }
  }
  const connection = getEphemeralVmRecipeResultConnection(result.data)
  if (connection.type === 'orca-server' && !parsePairingCode(connection.pairingCode)) {
    return { ok: false, error: 'Recipe result pairingCode is not a valid Orca pairing code.' }
  }
  if (!isAbsoluteRuntimePath(connection.projectRoot)) {
    return { ok: false, error: 'Recipe result projectRoot must be an absolute runtime path.' }
  }
  return { ok: true, result: result.data }
}

export function getEphemeralVmRecipeResultConnection(
  result: EphemeralVmRecipeResult
): EphemeralVmRecipeConnection {
  if ('connection' in result) {
    return result.connection
  }
  return {
    type: 'orca-server',
    pairingCode: result.pairingCode,
    projectRoot: result.projectRoot
  }
}

export function getEphemeralVmRecipeResultProjectRoot(result: EphemeralVmRecipeResult): string {
  return getEphemeralVmRecipeResultConnection(result).projectRoot
}

export function getEphemeralVmRecipeResultCheckoutMode(
  result: EphemeralVmRecipeResult
): 'orca-worktree' | 'provisioned-root' {
  return result.schemaVersion === 2 ? 'provisioned-root' : 'orca-worktree'
}

export function getEphemeralVmRecipeResultPairingCode(
  result: EphemeralVmRecipeResult
): string | null {
  const connection = getEphemeralVmRecipeResultConnection(result)
  return connection.type === 'orca-server' ? connection.pairingCode : null
}

export function isAbsoluteRuntimePath(path: string): boolean {
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith('\\\\') ||
    path.startsWith('//')
  )
}
