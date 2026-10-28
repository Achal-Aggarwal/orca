import { RpcOptionalUnknown } from './rpc-value-schemas'

// Keep the wire union canonical; main re-exports it.
export type GitAdmissionTier = 'interactive' | 'status' | 'background'

export const OptionalGitAdmissionTier = RpcOptionalUnknown.transform(
  (value): GitAdmissionTier | undefined => {
    return value === 'interactive' || value === 'status' || value === 'background'
      ? value
      : undefined
  }
)
