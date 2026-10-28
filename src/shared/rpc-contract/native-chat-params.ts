import {
  RpcNumber,
  RpcString,
  RpcUnknown,
  RpcOptionalNonemptyString,
  RpcOptionalNonnegativeInteger
} from './rpc-value-schemas'
import { z } from 'zod'
import type { AgentType } from '../native-chat-types'

// Expose the same transcript readers over RPC for paired mobile/web native chat.

export const NativeChatSession = z.object({
  agent: RpcUnknown.transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(RpcString.min(1, 'Missing agent'))
    .transform((v) => v as AgentType),
  sessionId: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing session id')
  ),
  // Clamp history windows so paging past the cap stops cleanly instead of failing “load earlier”.
  limit: RpcNumber.int()
    .positive()
    .transform((value) => Math.min(value, MOBILE_NATIVE_CHAT_MAX_WINDOW))
    .optional(),
  // Use the same cleanup token for registration/unsubscribe; absent retains legacy agent:sessionId keys.
  subscriptionId: RpcOptionalNonemptyString,
  // Hook transcript paths locate files when provider session IDs no longer name them; optional for old clients.
  transcriptPath: RpcOptionalNonemptyString,
  // Gate pending snapshots: legacy clients mistake them for settled empty history and overwrite retention/unblock drafts.
  capabilities: z
    .object({
      transcriptPending: z.literal(1).optional(),
      transcriptSourceOrder: z.literal(1).optional()
    })
    .optional(),
  beforeOffset: RpcOptionalNonnegativeInteger
})

export const NativeChatUnsubscribe = z.object({
  subscriptionId: RpcOptionalNonemptyString
})

export const MOBILE_NATIVE_CHAT_MAX_WINDOW = 2000
