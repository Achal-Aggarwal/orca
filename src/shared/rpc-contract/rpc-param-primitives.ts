import {
  RpcBoolean,
  RpcNull,
  RpcNumber,
  RpcString,
  RpcUndefined,
  RpcUnknown
} from './rpc-value-schemas'
import { z } from 'zod'

// Preserve legacy nonnumeric/nonfinite limits as absent. Zod v4 needs outer optional(): one hidden by pipe
// still makes object keys required.
export const OptionalFiniteNumber = RpcUnknown.transform((value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
)
  .pipe(z.union([RpcNumber, RpcUndefined]))
  .optional()

export const OptionalPositiveInt = RpcUnknown.transform((value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
)
  .pipe(z.union([RpcNumber, RpcUndefined]))
  .optional()

export const OptionalString = RpcUnknown.transform((value) =>
  typeof value === 'string' && value.length > 0 ? value : undefined
)
  .pipe(z.union([RpcString, RpcUndefined]))
  .optional()

export const OptionalPlainString = RpcUnknown.transform((value) =>
  typeof value === 'string' ? value : undefined
)
  .pipe(z.union([RpcString, RpcUndefined]))
  .optional()

export const OptionalBoolean = RpcUnknown.transform((value) =>
  typeof value === 'boolean' ? value : undefined
)
  .pipe(z.union([RpcBoolean, RpcUndefined]))
  .optional()

// Preserve three update meanings: undefined leaves unchanged, null clears, number sets.
export const TriStateLinkedIssue = RpcUnknown.transform((value) => {
  if (value === null) {
    return null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return undefined
})
  .pipe(z.union([RpcNumber, RpcNull, RpcUndefined]))
  .optional()

// Legacy browser targeting permits empty worktree (“any worktree”) but requires a nonempty page; preserve that asymmetry.
export const BrowserTarget = z.object({
  worktree: OptionalPlainString,
  page: OptionalString
})

export function requiredString(message: string) {
  return RpcUnknown.transform((value) => (typeof value === 'string' ? value : '')).pipe(
    RpcString.min(1, message)
  )
}

export function requiredStringAllowingEmpty(message: string) {
  return RpcUnknown.refine((value): value is string => typeof value === 'string', { message })
}

export function requiredNumber(message: string) {
  return RpcUnknown.transform((value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
  ).pipe(RpcNumber.refine((v) => Number.isFinite(v), { message }))
}
