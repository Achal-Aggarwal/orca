import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'

export const AntigravityAccountTargetParams = z
  .object({
    runtime: z.enum(['host', 'wsl']),
    wslDistro: RpcString.min(1).max(255).nullable().optional()
  })
  .strict()

export const AntigravityAccountMutationParams = z
  .object({
    target: AntigravityAccountTargetParams,
    accountId: RpcString.min(1).max(128)
  })
  .strict()

export const AntigravityChatSignInFlowParams = z.strictObject({
  flowId: RpcString.min(1).max(64)
})

export const AntigravityChatSignInCompleteParams = z.strictObject({
  flowId: RpcString.min(1).max(64),
  callbackUrl: RpcString.min(1).max(16_384)
})
