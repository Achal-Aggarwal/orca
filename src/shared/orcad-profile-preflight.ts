import { ScalarNonemptyString, ScalarPositiveInteger, ScalarString } from './scalar-value-schemas'
import { z } from 'zod'

export const ORCAD_PROFILE_PREFLIGHT_FLAG = '--orcad-profile-state-preflight'
export const ORCAD_STARTUP_PREFLIGHT_FLAG = '--orcad-startup-preflight'
export const ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS = 90_000
// Server startup follows the disposable native/SQLite probe on every bundled launch.
export const ORCAD_STARTUP_READINESS_TIMEOUT_MS = ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS + 90_000

export const ORCAD_PREFLIGHT_RUNTIMES = ['node', 'bun'] as const

/** The runtime the caller launched; the candidate must prove it ran under exactly this one. */
export type OrcadPreflightRuntimeIdentity = {
  runtime: (typeof ORCAD_PREFLIGHT_RUNTIMES)[number]
  runtimeVersion: string
}

export const orcadProfilePreflightResponseSchema = z.object({
  type: z.literal('orca_profile_state_ready'),
  nonce: ScalarString.uuid(),
  runtime: z.enum(ORCAD_PREFLIGHT_RUNTIMES),
  runtimeVersion: ScalarNonemptyString,
  artifactVersion: ScalarString.regex(/^\d+\.\d+\.\d+\+[a-f0-9]{12}$/),
  sqliteVersion: ScalarNonemptyString,
  revision: ScalarPositiveInteger
})

export type OrcadProfilePreflightResponse = z.infer<typeof orcadProfilePreflightResponseSchema>

/** A fresh challenge prevents stale or unrelated output from admitting a candidate. */
export function parseOrcadProfilePreflight(
  output: string,
  nonce: string,
  expected: OrcadPreflightRuntimeIdentity,
  artifactVersion?: string
): OrcadProfilePreflightResponse {
  const response = orcadProfilePreflightResponseSchema.parse(JSON.parse(output.trim()))
  if (
    response.nonce !== nonce ||
    response.runtime !== expected.runtime ||
    response.runtimeVersion !== expected.runtimeVersion ||
    (artifactVersion !== undefined && response.artifactVersion !== artifactVersion)
  ) {
    throw new Error('Profile preflight did not run under the expected candidate runtime')
  }
  return response
}
