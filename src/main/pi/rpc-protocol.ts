import {
  ScalarBoolean,
  ScalarNonemptyString,
  ScalarNumber,
  ScalarOptionalBoolean,
  ScalarOptionalNonnegativeInteger,
  ScalarOptionalNumber,
  ScalarOptionalString,
  ScalarOptionalUnknown,
  ScalarString
} from '../../shared/scalar-value-schemas'
import { z } from 'zod'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'

export const piRpcModelSchema = z.looseObject({
  id: ScalarString,
  provider: ScalarString,
  name: ScalarOptionalString,
  contextWindow: ScalarNumber.nonnegative().optional(),
  reasoning: ScalarOptionalBoolean,
  input: z.array(ScalarString).optional()
})
export type PiRpcModel = z.infer<typeof piRpcModelSchema>

export const piRpcStateSchema = z.looseObject({
  model: piRpcModelSchema.nullish(),
  thinkingLevel: ScalarOptionalString,
  sessionFile: ScalarNonemptyString,
  sessionId: ScalarOptionalString,
  isStreaming: ScalarBoolean,
  isCompacting: ScalarBoolean,
  pendingMessageCount: ScalarOptionalNonnegativeInteger
})
export type PiRpcState = z.infer<typeof piRpcStateSchema>

export function piRpcIdle(state: PiRpcState): boolean {
  return !state.isStreaming && !state.isCompacting && (state.pendingMessageCount ?? 0) === 0
}

export const piRpcContentSchema = z.looseObject({
  type: ScalarString,
  text: ScalarOptionalString,
  thinking: ScalarOptionalString
})
export const piRpcUsageSchema = z.object({
  input: ScalarNumber.nonnegative(),
  output: ScalarNumber.nonnegative(),
  cacheRead: ScalarNumber.nonnegative(),
  cacheWrite: ScalarNumber.nonnegative()
})
export const piRpcMessageSchema = z.looseObject({
  role: ScalarString,
  content: z.union([ScalarString, z.array(piRpcContentSchema)]),
  stopReason: ScalarOptionalString,
  errorMessage: ScalarOptionalString,
  usage: piRpcUsageSchema.optional(),
  timestamp: ScalarOptionalNumber
})
export const piRpcMessageEventSchema = z.object({
  type: z.enum(['message_start', 'message_update', 'message_end']),
  message: piRpcMessageSchema.optional(),
  usage: piRpcUsageSchema.optional(),
  assistantMessageEvent: z
    .looseObject({
      type: ScalarString,
      delta: ScalarOptionalString,
      contentIndex: ScalarOptionalNonnegativeInteger,
      partial: piRpcMessageSchema.optional()
    })
    .optional()
})
export type PiRpcMessageEvent = z.infer<typeof piRpcMessageEventSchema>

// The chat never shows these payloads; only their lifecycle step matters.
const LIFECYCLE_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'turn_end',
  'agent_end',
  'compaction_end',
  'auto_compaction_end'
])

// Pi writes these fields before the payload, so they survive in an oversized record's prefix.
const SKIPPED_TOOL_HEAD =
  /^\{"type":"tool_execution_(?:start|update|end)","toolCallId":"([^"\\]+)","toolName":"([^"\\]+)"/
const SKIPPED_MESSAGE_HEAD = /^\{"type":"message_(?:start|end)","message":\{"role":"([A-Za-z]+)"/
const SKIPPED_RETRY_END_HEAD = /^\{"type":"auto_retry_end","success":(true|false)[,}]/

/** What an event over the line limit still applies without its payload, and whether the chat lost content. */
export function piRpcSkippedEvent(
  type: string,
  prefix: string
): { head: JsonlRpcRecord | null; contentLost: boolean } {
  if (LIFECYCLE_ONLY_EVENTS.has(type)) {
    return { head: { type }, contentLost: false }
  }
  const tool = SKIPPED_TOOL_HEAD.exec(prefix)
  const role = SKIPPED_MESSAGE_HEAD.exec(prefix)?.[1]
  const retry = SKIPPED_RETRY_END_HEAD.exec(prefix)?.[1]
  // An oversized tool result is content, not a short error, so an ended call closes as completed.
  const head = tool
    ? { type, toolCallId: tool[1], toolName: tool[2] }
    : role
      ? { type, message: { role, content: [] } }
      : retry
        ? { type, success: retry === 'true' }
        : type === 'message_update' || type === 'auto_retry_start'
          ? { type }
          : null
  return { head, contentLost: true }
}

export const piRpcToolEventSchema = z.object({
  type: z.enum(['tool_execution_start', 'tool_execution_update', 'tool_execution_end']),
  toolCallId: ScalarString,
  toolName: ScalarString,
  args: ScalarOptionalUnknown,
  partialResult: ScalarOptionalUnknown,
  result: ScalarOptionalUnknown,
  isError: ScalarOptionalBoolean
})
export type PiRpcToolEvent = z.infer<typeof piRpcToolEventSchema>

export const piRpcPromptReplySchema = z.object({
  type: z.literal('response'),
  command: z.literal('prompt'),
  success: ScalarBoolean,
  error: ScalarOptionalString,
  data: z
    .object({
      disposition: z.enum(['started', 'queued', 'handled']).optional(),
      agentInvoked: ScalarOptionalBoolean
    })
    .optional()
})

export const piRpcDialogSchema = z.discriminatedUnion('method', [
  z.object({
    id: z.union([ScalarString, ScalarNumber]),
    method: z.literal('confirm'),
    title: ScalarString,
    message: ScalarOptionalString
  }),
  z.object({
    id: z.union([ScalarString, ScalarNumber]),
    method: z.literal('select'),
    title: ScalarString,
    message: ScalarOptionalString,
    options: z.array(ScalarString).min(1).max(64)
  }),
  z.object({
    id: z.union([ScalarString, ScalarNumber]),
    method: z.enum(['input', 'editor']),
    title: ScalarString,
    message: ScalarOptionalString,
    placeholder: ScalarOptionalString,
    prefill: ScalarOptionalString
  })
])
export type PiRpcDialog = z.infer<typeof piRpcDialogSchema>
