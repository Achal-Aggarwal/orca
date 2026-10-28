import { ScalarBoolean, ScalarNonemptyString, ScalarString } from './scalar-value-schemas'
/** Carry relay-proven spawn faults to client-side repair: a rebuildable ABI mismatch differs from an unsupported host.
 * Optional JSON-RPC error data is additive; older clients keep rendering error.message without negotiation.
 * repairable requires proof that rebuilding node-pty fixes the fault. Unverifiable probes must never trigger repair (#14830). */
import { z } from 'zod'
import { TERMINAL_UNAVAILABLE_ERROR_CODE } from './runtime-capability-degradation'

export const TERMINAL_UNAVAILABLE_RPC_ERROR_CODE = TERMINAL_UNAVAILABLE_ERROR_CODE

const TerminalUnavailableHostSchema = z
  .object({
    platform: ScalarNonemptyString.max(32),
    arch: ScalarNonemptyString.max(32),
    libc: z.enum(['glibc', 'musl', 'none']),
    /** Absent, not null, when the host reports no version — see native-host-abi.ts. */
    glibcVersion: ScalarNonemptyString.max(32).optional(),
    /** `NODE_MODULE_VERSION` the remote runtime accepts. */
    nodeAbi: ScalarNonemptyString.max(16),
    nodeVersion: ScalarNonemptyString.max(32)
  })
  .strict()

export const TerminalUnavailableCauseSchema = z
  .object({
    /** `blocked` — proved. `unverifiable` — nothing answered; never act on it. */
    status: z.enum(['blocked', 'unverifiable']),
    /** Keep reason open so newer relay reasons do not discard the whole cause, including repairable. */
    reason: ScalarNonemptyString.max(64),
    detail: ScalarString.max(400),
    /** Proved, and rebuilding node-pty on the host is the fix. */
    repairable: ScalarBoolean,
    host: TerminalUnavailableHostSchema,
    /** The dynamic loader's own words, when they were recovered. */
    rawError: ScalarString.max(1000).optional()
  })
  .strict()

export type TerminalUnavailableCause = z.infer<typeof TerminalUnavailableCauseSchema>
