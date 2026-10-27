import type { RuntimeStatus } from '../../../shared/runtime-types'

export const RUNTIME_COMPATIBILITY_CACHE_MAX = 32

export const RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS = 60_000

// Why: capability verdicts must eventually follow a saved environment's version changes.
export const RUNTIME_CAPABILITY_STATUS_TTL_MS = 60_000

export type RuntimeCompatibilityCacheEntry = {
  check: Promise<void>
  failedAt: number | null
  // False while probing so recovery can drop a doomed pending compatibility check.
  provenCompatible: boolean
  status: RuntimeStatus | null
  statusCheckedAt: number | null
}

export const runtimeCompatibilityChecks = new Map<string, RuntimeCompatibilityCacheEntry>()

/** A pending probe by default; an observed status is proof of itself. */
export function compatibilityEntry(
  status: RuntimeStatus | null = null,
  provenCompatible = status !== null
): RuntimeCompatibilityCacheEntry {
  const statusCheckedAt = status ? Date.now() : null
  return { check: Promise.resolve(), failedAt: null, provenCompatible, status, statusCheckedAt }
}

export function getCachedRuntimeCompatibilityCheck(
  environmentId: string,
  options: { reuseRecentCompatibilityFailure?: boolean }
): RuntimeCompatibilityCacheEntry | null {
  const cached = runtimeCompatibilityChecks.get(environmentId)
  if (!cached) {
    return null
  }
  if (
    cached.failedAt !== null &&
    Date.now() - cached.failedAt >= RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS
  ) {
    runtimeCompatibilityChecks.delete(environmentId)
    return null
  }
  if (cached.failedAt !== null && options.reuseRecentCompatibilityFailure !== true) {
    return null
  }
  runtimeCompatibilityChecks.delete(environmentId)
  runtimeCompatibilityChecks.set(environmentId, cached)
  return cached
}
