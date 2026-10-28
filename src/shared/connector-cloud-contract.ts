import {
  ScalarNonemptyString,
  ScalarNonnegativeInteger,
  ScalarOptionalUnknown,
  ScalarPositiveInteger,
  ScalarUnknown
} from './scalar-value-schemas'
// Mirror of cloud/packages/connector-contract/src for the machine side of the Orca Cloud connector.
import { z } from 'zod'
import type { PendingPrompt } from './agent-pending-prompt'

export const CONNECTOR_CONTRACT_VERSION = 1

// Every route is POST except hello (PUT), and takes `Authorization: Bearer <connector token>`.
export const CONNECTOR_PATHS = {
  hello: '/v1/connector/hello',
  poll: '/v1/connector/poll',
  acks: '/v1/connector/acks',
  events: '/v1/connector/events',
  replies: '/v1/connector/replies'
} as const

export const CONNECTOR_FEATURES = ['answer', 'cancel', 'reply'] as const

export const CONNECTOR_CLIENT_LIMITS = {
  pollTimeoutMs: 70_000,
  minDeadlineLeftMs: 10_000,
  maxLastAssistantMessageBytes: 8 * 1024,
  // The cloud refuses a larger request body with 413.
  maxRequestBytes: 256 * 1024,
  // One event's JSON, so any single event fits in an events request.
  maxEventBytes: 192 * 1024,
  // A snapshot lists linked conversations active in the last 7 days, newest first, up to this many.
  maxSnapshotConversations: 200,
  snapshotActiveWindowMs: 7 * 24 * 60 * 60 * 1000,
  // A hello lists the most recently used projects, up to this many, and always fits maxRequestBytes.
  maxHelloProjects: 500,
  maxDisplayTextLength: 200
} as const

// Machine-side readers: they keep what this Orca uses and ignore fields a newer cloud adds.
export const ConnectorErrorResponse = z.object({ error: ScalarNonemptyString })

// Each hello gets a revision above every earlier one for this machine; polls, acks and events carry it.
export const ConnectorHelloResponse = z.object({ helloRev: ScalarPositiveInteger })

/** Where an Orca Cloud conversation comes from. */
export const CONNECTOR_CLOUD_SOURCES = ['slack', 'discord', 'linear'] as const

export const ConnectorConversation = z.object({
  source: z.enum(CONNECTOR_CLOUD_SOURCES),
  externalId: ScalarNonemptyString
})
export type ConnectorConversation = z.infer<typeof ConnectorConversation>

/** The conversation as Orca Cloud names it; null for one that never came through the cloud (e.g. `dev`). */
export function cloudConversation(key: {
  source: string
  externalId: string
}): ConnectorConversation | null {
  const parsed = ConnectorConversation.safeParse(key)
  return parsed.success ? parsed.data : null
}

const DeliveryBase = {
  deliveryId: ScalarNonemptyString,
  expiresAt: ScalarPositiveInteger,
  conversation: ConnectorConversation
}

export const ConnectorDelivery = z.discriminatedUnion('kind', [
  z.object({
    ...DeliveryBase,
    kind: z.literal('start'),
    agent: ScalarNonemptyString,
    placeId: ScalarNonemptyString,
    prompt: ScalarNonemptyString
  }),
  z.object({ ...DeliveryBase, kind: z.literal('send'), text: ScalarNonemptyString }),
  z.object({
    ...DeliveryBase,
    kind: z.literal('answer'),
    promptId: ScalarNonemptyString,
    optionId: ScalarNonemptyString
  }),
  z.object({ ...DeliveryBase, kind: z.literal('cancel') })
])
export type ConnectorDelivery = z.infer<typeof ConnectorDelivery>

/** Enough of a delivery this Orca cannot read to settle it as unsupported. */
export const ConnectorDeliveryId = z.object({ deliveryId: ScalarNonemptyString })

// Each delivery and the control are read one by one, so one this Orca cannot read never drops the rest.
export const ConnectorPollResponse = z.object({
  serverNow: ScalarPositiveInteger,
  holdMs: ScalarNonnegativeInteger,
  unsettled: z
    .array(z.object({ deliveryId: ScalarNonemptyString, conversation: ConnectorConversation }))
    .optional(),
  deliveries: z.array(ScalarUnknown),
  control: ScalarOptionalUnknown
})

export const ConnectorReplyResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('posted'), messageId: ScalarNonemptyString }),
  z.object({ status: z.literal('queued') })
])
export type ConnectorReplyResponse = z.infer<typeof ConnectorReplyResponse>

export const ConnectorPollControl = z.union([
  z.object({ stop: ScalarNonemptyString }),
  z.object({ pausedForMs: ScalarPositiveInteger }),
  z.object({ reconnect: z.literal(true) })
])
export type ConnectorPollControl = z.infer<typeof ConnectorPollControl>

export type ConnectorProject = {
  placeId: string
  name: string
  remote?: string
  kind: 'git' | 'folder'
  where: { kind: 'local' | 'ssh' | 'wsl'; label?: string }
}

export type ConnectorDeliveryResult =
  | { outcome: 'accepted'; reopened?: true }
  | { outcome: 'refused' | 'unknown'; reason: string }
  | { outcome: 'expired' | 'unsupported' }

export type ConnectorAck =
  | { deliveryId: string; step: 'received' }
  | { deliveryId: string; step: 'done'; result: ConnectorDeliveryResult }

type PaneEvent = { conversation: ConnectorConversation; paneKey: string }

export type ConnectorEvent =
  | (PaneEvent & { kind: 'linked'; agent: string })
  | (PaneEvent & { kind: 'prompt'; prompt: PendingPrompt })
  | (PaneEvent & { kind: 'turn-started'; at: number })
  | (PaneEvent & {
      kind: 'turn-ended'
      turnId: number
      at: number
      stopReason: string | null
      lastAssistantMessage?: string
    })
  | {
      kind: 'snapshot'
      conversations: (PaneEvent & {
        agent: string
        working: boolean
        prompt: PendingPrompt | null
        // The pane's latest turn; a turn end older than it changes nothing.
        turnId?: number
      })[]
    }
