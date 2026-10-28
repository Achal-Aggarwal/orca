import {
  ScalarBoolean,
  ScalarFiniteNumber,
  ScalarNonemptyString,
  ScalarNonnegativeInteger,
  ScalarNullableNumber,
  ScalarNullableString,
  ScalarNumber,
  ScalarOptionalBoolean,
  ScalarOptionalFiniteNumber,
  ScalarOptionalNonemptyString,
  ScalarOptionalNonnegativeInteger,
  ScalarOptionalNumber,
  ScalarOptionalString,
  ScalarOptionalUnknown,
  ScalarString
} from './scalar-value-schemas'
// Validate replayed JSON deeply before unguarded reducers/renderers read it; malformed rows fail load without deletion.
// Extend with keys, open-union tags or a new row v; never tighten existing types/bounds/closed sets.
// Unknown keys and string vocabularies survive; unknown bodies/blocks/goals/subjects remain undrawn and writable.
// Unreadable context usage alone is dropped (journal-row-unusable-annotations.ts).
// Older rewind replaces unknown turn/tool/resolution states with placeholders and blocks with raw-JSON text, retaining unknown bodies.
// History pages lack row v: extensions must also remain safe for older clients (journal-closed-sets.test.ts).

import { z } from 'zod'
import { AgentSessionContextUsageSchema } from './agent-session-context-usage-schema'
import { AgentJournalThreadGoalStateSchema } from './agent-session-journal-thread-goal-schema'
import { AgentSessionFailureFactSchema } from './agent-session-failure-fact-schema'
import { knownTags, openDiscriminatedUnion } from './agent-session-journal-open-union'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalResolution,
  AgentJournalRenderItem
} from './agent-session-journal-types'

const BoundedPayload = z.object({
  head: ScalarString,
  byteLength: ScalarNumber,
  digest: ScalarString,
  truncated: ScalarBoolean
})

const ProviderFrame = z.object({
  provider: ScalarString,
  kind: ScalarString,
  payload: BoundedPayload
})

const ToolMetadata = {
  mcpIdentity: z.object({ server: ScalarString, tool: ScalarString }).optional(),
  exitCode: ScalarNumber.int().optional(),
  durationMs: ScalarNumber.nonnegative().optional(),
  webSearchResults: z.array(z.object({ title: ScalarString, url: ScalarString })).optional()
}

/** Provider IDs are opaque; reject all-whitespace values without rewriting valid IDs. */
const ProviderCallId = ScalarString.refine(
  (value) => value.trim().length > 0,
  'callId must contain a non-whitespace character'
)

/** Keep lifecycle strings open so newer states do not make persisted rows malformed. */
const SubagentEntry = z.object({
  id: ScalarString,
  label: ScalarString,
  state: ScalarNonemptyString,
  tokens: ScalarOptionalNumber,
  startedAt: ScalarOptionalNumber,
  settledAt: ScalarOptionalNumber
})

/** Skip unknown block types, but reject malformed payloads of known types. */
const Block = openDiscriminatedUnion(
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      text: ScalarString,
      presentation: ScalarOptionalString,
      tone: ScalarOptionalString,
      providerFrame: ProviderFrame.optional()
    }),
    // JSON.stringify drops input: undefined, so persisted canonical calls may omit it.
    z.object({
      type: z.literal('tool-call'),
      name: ScalarString,
      input: ScalarOptionalUnknown,
      callId: ProviderCallId.optional(),
      ...ToolMetadata
    }),
    z.object({
      type: z.literal('tool-result'),
      output: ScalarString,
      isError: ScalarOptionalBoolean
    }),
    z.object({
      type: z.literal('image-ref'),
      path: ScalarOptionalString,
      url: ScalarOptionalString,
      alt: ScalarOptionalString
    }),
    z.object({
      type: z.literal('subagent-group'),
      groupId: ScalarString,
      agents: z.array(SubagentEntry)
    }),
    // `outcomeBasis` and `background` stay open for the same reason `state` does.
    SubagentEntry.extend({
      type: z.literal('subagent'),
      groupId: ScalarString,
      parentId: ScalarOptionalString,
      run: ScalarOptionalString,
      outcomeBasis: ScalarOptionalString,
      background: ScalarOptionalBoolean
    }),
    // Keep kind/state open for newer vocabularies; renderers fall back on unknown values.
    z.object({
      type: z.literal('background-task'),
      taskId: ScalarNonemptyString,
      kind: ScalarNonemptyString,
      label: ScalarString,
      state: ScalarNonemptyString,
      parentToolUseId: ScalarOptionalString,
      summary: ScalarOptionalString,
      error: ScalarOptionalString,
      outputFile: ScalarOptionalString,
      tokens: ScalarOptionalNumber,
      startedAt: ScalarOptionalNumber,
      settledAt: ScalarOptionalNumber
    })
  ])
)

const PromptOption = z.object({
  id: ScalarString,
  label: ScalarString,
  description: ScalarOptionalString
})

const FreeTextInput = z.object({
  allowEmpty: ScalarOptionalBoolean,
  multiline: ScalarOptionalBoolean,
  initialValue: ScalarOptionalString,
  placeholder: ScalarOptionalString
})

const Question = z.object({
  id: ScalarString,
  question: ScalarString,
  header: ScalarOptionalString,
  multiSelect: ScalarBoolean,
  options: z.array(PromptOption),
  freeTextQuestionId: ScalarOptionalString,
  freeTextInput: FreeTextInput.optional()
})

const Resolution = z.object({
  state: ScalarNonemptyString,
  selectedOptionId: ScalarNullableString,
  answers: z
    .array(
      z.object({
        questionId: ScalarString,
        optionIds: z.array(ScalarString),
        other: ScalarOptionalString
      })
    )
    .optional(),
  resolvedBy: ScalarNullableString,
  resolvedAt: ScalarNullableNumber
})

const ApprovalMatchedAskRule = z.object({
  source: ScalarString,
  toolName: ScalarString,
  ruleContent: ScalarOptionalString
})

const KnownApprovalSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), text: ScalarNonemptyString, filePath: ScalarOptionalString })
])
export const AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS = knownTags(KnownApprovalSubject)
/** Open like blocks; a subject this build cannot draw is never approvable here
 *  (agent-session-approval-subject.ts). */
const ApprovalSubject = openDiscriminatedUnion(KnownApprovalSubject)

const MessageBody = z.object({
  kind: z.literal('message'),
  role: ScalarNonemptyString,
  blocks: z.array(Block),
  // Open like roles: a send mode a newer build writes must not turn the row malformed.
  sentAs: ScalarOptionalNonemptyString,
  command: z.object({ name: ScalarNonemptyString }).optional(),
  skills: z.array(z.object({ name: ScalarNonemptyString, path: ScalarNonemptyString })).optional(),
  // Open like `sentAs`: a state a newer host writes reads as completed, never malformed.
  state: ScalarOptionalNonemptyString,
  completedAt: ScalarOptionalFiniteNumber
})

/** A turn's lifecycle, as the turn item and the legacy status row both carry it. */
const TurnLifecycleFields = {
  turnId: ScalarString,
  state: ScalarNonemptyString,
  // Keep newer verdicts readable; readAgentJournalTurnOutcome maps unplaceable ones to unknown.
  outcome: ScalarOptionalNonemptyString,
  userItemId: ScalarOptionalNonemptyString,
  startedAt: ScalarFiniteNumber.positive().optional(),
  requestedAt: ScalarFiniteNumber.positive().optional(),
  completedAt: ScalarFiniteNumber.positive().optional(),
  durationMs: ScalarFiniteNumber.nonnegative().optional()
}

const KnownItemBody = z.discriminatedUnion('kind', [
  MessageBody,
  z.object({
    kind: z.literal('tool-call'),
    ...ToolMetadata,
    name: ScalarString,
    // See the tool-call block: the key itself is lost when `input` is undefined.
    input: ScalarOptionalUnknown,
    callId: ProviderCallId.optional(),
    state: ScalarNonemptyString,
    // Open like `state`: an ending a newer build writes reads as the `state` beside it.
    endedAs: ScalarOptionalNonemptyString,
    output: BoundedPayload.optional()
  }),
  z.object({ kind: z.literal('diff'), path: ScalarString, patch: BoundedPayload }),
  z.object({
    kind: z.literal('approval'),
    title: ScalarString,
    displayName: ScalarOptionalString,
    description: ScalarOptionalString,
    decisionReason: ScalarOptionalString,
    blockedPath: ScalarOptionalString,
    matchedAskRule: ApprovalMatchedAskRule.optional(),
    subject: ApprovalSubject.optional(),
    detail: ScalarNullableString,
    options: z.array(PromptOption),
    resolution: Resolution
  }),
  z.object({
    kind: z.literal('question'),
    question: ScalarString,
    options: z.array(PromptOption),
    questions: z.array(Question).optional(),
    freeTextQuestionId: ScalarOptionalString,
    freeTextInput: FreeTextInput.optional(),
    resolution: Resolution
  }),
  z.object({
    kind: z.literal('status'),
    text: ScalarString,
    presentation: ScalarOptionalString,
    contextClear: z
      .object({
        operationId: ScalarNonemptyString.max(512),
        afterFence: ScalarNonnegativeInteger,
        clearedAt: ScalarNonnegativeInteger
      })
      .optional(),
    tone: ScalarOptionalString,
    turnLifecycle: z.object(TurnLifecycleFields).optional(),
    providerFrame: ProviderFrame.optional(),
    threadGoal: AgentJournalThreadGoalStateSchema.optional(),
    failure: AgentSessionFailureFactSchema.optional(),
    orcaStop: z.object({ cause: ScalarNonemptyString }).optional()
  }),
  z.object({
    kind: z.literal('turn'),
    ...TurnLifecycleFields,
    contextUsage: AgentSessionContextUsageSchema.optional(),
    providerTurnId: ScalarOptionalNonemptyString
  })
])

/** Every body kind this build knows; a body of another kind is kept as-is and drawn by nobody. */
export const AGENT_JOURNAL_ITEM_BODY_KINDS = knownTags(KnownItemBody)
export const AgentJournalItemBodySchema = openDiscriminatedUnion(KnownItemBody)

/** Keep producerKind open so newer producer types remain readable across the wire. */
export const AgentJournalProducerLinkageFields = {
  // Empty IDs count as present and would permanently hide a parent's own row from parent-scoped readers.
  agentId: ScalarOptionalNonemptyString,
  parentAgentId: ScalarOptionalNonemptyString,
  providerParentRef: ScalarOptionalNonemptyString,
  producerKind: ScalarOptionalNonemptyString,
  attempt: ScalarNumber.int().optional()
} as const

/** Preserve unknown scope kinds from newer hosts without claiming a turn boundary or rejecting their content. */
export const AgentJournalTurnScopeSchema = z.object({
  kind: ScalarNonemptyString,
  turnItemId: ScalarOptionalNonemptyString
})

export const AgentJournalRenderItemSchema = z.object({
  itemId: ScalarNonemptyString,
  revision: ScalarNumber.int(),
  body: AgentJournalItemBodySchema,
  sequence: ScalarNumber.int(),
  sequenceIndex: ScalarOptionalNonnegativeInteger,
  observedAt: ScalarNumber,
  recovered: z.literal(true).optional(),
  recoveredAt: ScalarOptionalNumber,
  turnScope: AgentJournalTurnScopeSchema.optional(),
  shortened: z.literal(true).optional(),
  ...AgentJournalProducerLinkageFields
})

export function isAgentJournalResolution(value: unknown): value is AgentJournalResolution {
  return Resolution.safeParse(value).success
}

export function isAdmissibleAgentJournalItemBody(value: unknown): value is AgentJournalItemBody {
  return AgentJournalItemBodySchema.safeParse(value).success
}

/** Submission rows may only carry a user-authored message body. */
export function isAdmissibleAgentJournalMessageBody(
  value: unknown
): value is AgentJournalMessageItem {
  return MessageBody.safeParse(value).success
}

export function isAdmissibleAgentJournalRenderItem(
  value: unknown
): value is AgentJournalRenderItem {
  return AgentJournalRenderItemSchema.safeParse(value).success
}

/** Prove canonical writes are admissible on replay; open-string schemas are deliberately wider, so the converse need not hold. */
type Admits<T extends true> = T
export type CanonicalJournalTypesAreAdmissible = [
  Admits<AgentJournalItemBody extends z.input<typeof AgentJournalItemBodySchema> ? true : false>,
  Admits<AgentJournalMessageItem extends z.input<typeof MessageBody> ? true : false>,
  Admits<AgentJournalRenderItem extends z.input<typeof AgentJournalRenderItemSchema> ? true : false>
]
