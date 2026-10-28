import {
  RpcBoolean,
  RpcNull,
  RpcNullishString,
  RpcNumber,
  RpcString,
  RpcUnknown,
  RpcNonemptyString,
  RpcOptionalNonemptyString
} from './rpc-value-schemas'
import { z } from 'zod'

export const ManagedDataAccountProviderParams = z.object({
  provider: z.enum(['opencode', 'devin'])
})
export const AddDataAccountParams = ManagedDataAccountProviderParams.extend({
  sourceDataHome: RpcNonemptyString,
  label: RpcString.trim().min(1).max(120)
})
export const SelectDataAccountParams = ManagedDataAccountProviderParams.extend({
  accountId: z.uuid().nullable()
})
export const RemoveDataAccountParams = ManagedDataAccountProviderParams.extend({
  accountId: z.uuid()
})

export const CodexResetTarget = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('host'), wslDistro: RpcNull }).strict(),
  // Why: reset scope must identify one exact WSL distro; null means all slots only for selection.
  z.object({ runtime: z.literal('wsl'), wslDistro: RpcString.trim().min(1).max(255) }).strict()
])

export const CodexSelectionTarget = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('host'), wslDistro: RpcNull }).strict(),
  z
    .object({
      runtime: z.literal('wsl'),
      // A null distro intentionally means all WSL selection slots.
      wslDistro: RpcString.trim().min(1).max(255).nullable()
    })
    .strict()
])

export const SelectAccountParams = z.object({
  accountId: z
    .union([RpcString.min(1, 'Missing accountId'), RpcNull])
    .transform((v) => (v === null ? null : v))
})

export const SelectCodexAccountForTargetParams = SelectAccountParams.extend({
  target: CodexSelectionTarget
})

export const RemoveAccountParams = z.object({
  accountId: RpcString.min(1, 'Missing accountId')
})

export const CodexResetExpectedScope = z
  .object({
    target: CodexResetTarget,
    accountId: RpcString.min(1, 'Missing accountId').max(512),
    accountRevision: RpcNumber.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offerRevision: RpcString.startsWith('v1:', 'Invalid offerRevision').max(4_096)
  })
  .strict()

export const ConsumeCodexResetCreditParams = z
  .object({
    // Retries share a host-ledger attempt so the same offer/account never spends a credit twice.
    idempotencyKey: z.uuid('Invalid idempotencyKey'),
    expectedScope: CodexResetExpectedScope
  })
  .strict()

export const AddClaudeFromConfigDirParams = z.object({
  configDir: RpcString.min(1, 'Missing configDir'),
  runtime: z.enum(['host', 'wsl']).optional(),
  wslDistro: RpcNullishString,
  previousLegacyCredentialsSha256: RpcString.regex(
    /^[a-f0-9]{64}$/,
    'Invalid legacy credential digest'
  )
    .nullable()
    .optional()
})

export const AddCodexFromHomeParams = z.object({
  sourceHome: RpcString.min(1, 'Missing sourceHome'),
  runtime: z.enum(['host', 'wsl']).optional(),
  wslDistro: RpcNullishString
})

// Account list opts out: forced usage refresh bypasses throttle/Retry-After and costs a serial round trip per account.
export const ListAccountsParams = z.object({
  refreshUsage: RpcBoolean.default(true)
})

export const AccountsUnsubscribeParams = z.object({
  subscriptionId: RpcUnknown.transform((value) =>
    typeof value === 'string' && value.length > 0 ? value : ''
  ).pipe(RpcString.min(1, 'Missing subscriptionId'))
})

const ClaudeSignInTarget = {
  runtime: z.enum(['host', 'wsl']).optional(),
  wslDistro: RpcNullishString
}

export const BeginClaudeSignInParams = z
  .object({ accountId: RpcOptionalNonemptyString, ...ClaudeSignInTarget })
  .strict()

export const FinishClaudeSignInParams = z
  .object({ accountId: RpcNonemptyString, ...ClaudeSignInTarget })
  .strict()

export const HostAccountSignInStartParams = z.object({ provider: z.enum(['claude', 'codex']) })

export const HostAccountSignInWaitParams = z.object({
  flowId: RpcString.min(1).max(64),
  afterRevision: RpcNumber.int().nonnegative().default(0)
})

export const HostAccountSignInFlowParams = z.object({ flowId: RpcString.min(1).max(64) })

export const HostAccountSignInCodeParams = HostAccountSignInFlowParams.extend({
  code: RpcString.trim()
    .min(1, 'Paste the code from the sign-in page.')
    .max(4_096)
    // Why: the code becomes one line on the login's stdin; a newline inside it would answer twice.
    .regex(/^[^\s\p{Cc}]+$/u, 'That code has spaces or line breaks in it. Copy it again.')
})
