import {
  ScalarBoolean,
  ScalarNonemptyString,
  ScalarNonnegativeInteger,
  ScalarOptionalString,
  ScalarOptionalUnknown,
  ScalarString,
  ScalarUnknown
} from '../scalar-value-schemas'
import { z } from 'zod'
import { PLUGIN_COMMAND_LIMIT, PLUGIN_EVENT_NAMES, pluginCommandIdSchema } from './plugin-manifest'
import { PLUGIN_CAPABILITY_KINDS } from './plugin-capabilities'

/** Validate fork-channel messages on both sides: third-party worker code cannot supply trusted structure. */

export const pluginWorkerInitSchema = z.object({
  type: z.literal('init'),
  /** Qualified `<publisher>.<id>` key. */
  pluginId: ScalarNonemptyString,
  pluginRoot: ScalarNonemptyString,
  mainEntry: ScalarNonemptyString,
  /** Worker-side early refusals only; host rechecks every call regardless of declared grants. */
  grantedCapabilities: z.array(z.enum(PLUGIN_CAPABILITY_KINDS))
})

export const pluginWorkerInvokeCommandSchema = z.object({
  type: z.literal('invokeCommand'),
  callId: ScalarNonnegativeInteger,
  commandId: ScalarNonemptyString,
  args: ScalarOptionalUnknown
})

export const pluginWorkerDeliverEventSchema = z.object({
  type: z.literal('deliverEvent'),
  eventId: ScalarNonnegativeInteger,
  event: z.enum(PLUGIN_EVENT_NAMES),
  payload: ScalarUnknown
})

export const pluginWorkerHostResultSchema = z.object({
  type: z.literal('hostResult'),
  callId: ScalarNonnegativeInteger,
  ok: ScalarBoolean,
  value: ScalarOptionalUnknown,
  errorCode: ScalarOptionalString,
  error: ScalarOptionalString
})

export const pluginWorkerShutdownSchema = z.object({ type: z.literal('shutdown') })

export const pluginWorkerParentMessageSchema = z.discriminatedUnion('type', [
  pluginWorkerInitSchema,
  pluginWorkerInvokeCommandSchema,
  pluginWorkerDeliverEventSchema,
  pluginWorkerHostResultSchema,
  pluginWorkerShutdownSchema
])

export const pluginWorkerReadySchema = z.object({
  type: z.literal('ready'),
  /** Command ids the worker registered handlers for (⊆ manifest commands). */
  commands: z.array(pluginCommandIdSchema).max(PLUGIN_COMMAND_LIMIT)
})

export const pluginWorkerCommandResultSchema = z.object({
  type: z.literal('commandResult'),
  callId: ScalarNonnegativeInteger,
  ok: ScalarBoolean,
  // Fork IPC supplies cloneable data, but callers still validate the opaque result’s shape.
  value: ScalarOptionalUnknown,
  error: ScalarString.max(8192).optional()
})

export const pluginWorkerEventAckSchema = z.object({
  type: z.literal('eventAck'),
  eventId: ScalarNonnegativeInteger
})

/** Worker→host API call (the plugin SDK's transport for host methods). */
export const pluginWorkerHostCallSchema = z.object({
  type: z.literal('hostCall'),
  callId: ScalarNonnegativeInteger,
  method: ScalarNonemptyString,
  params: ScalarOptionalUnknown
})

export const pluginWorkerLogSchema = z.object({
  type: z.literal('log'),
  level: z.enum(['info', 'warn', 'error']),
  message: ScalarString.max(8192)
})

export const pluginWorkerFatalSchema = z.object({
  type: z.literal('fatal'),
  error: ScalarString.max(8192)
})

export const pluginWorkerChildMessageSchema = z.discriminatedUnion('type', [
  pluginWorkerReadySchema,
  pluginWorkerCommandResultSchema,
  pluginWorkerEventAckSchema,
  pluginWorkerHostCallSchema,
  pluginWorkerLogSchema,
  pluginWorkerFatalSchema
])

export type PluginWorkerParentMessage = z.infer<typeof pluginWorkerParentMessageSchema>
export type PluginWorkerChildMessage = z.infer<typeof pluginWorkerChildMessageSchema>
export type PluginWorkerInit = z.infer<typeof pluginWorkerInitSchema>

export const PLUGIN_WORKER_READY_TIMEOUT_MS = 10_000
export const PLUGIN_WORKER_INVOKE_TIMEOUT_MS = 30_000
/** Dispose idle workers and refork on their next trigger. */
export const PLUGIN_WORKER_IDLE_REAP_MS = 5 * 60_000
/** Default cap on concurrently-active workers; excess activations queue. */
export const PLUGIN_WORKER_MAX_ACTIVE_DEFAULT = 5
