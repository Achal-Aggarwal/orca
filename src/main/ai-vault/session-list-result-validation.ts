import {
  ScalarNonemptyString,
  ScalarNullableString,
  ScalarNumber,
  ScalarOptionalBoolean,
  ScalarOptionalNullableString,
  ScalarString,
  ScalarUnknown
} from '../../shared/scalar-value-schemas'
import { z } from 'zod'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultAgent,
  type AiVaultListResult,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { normalizeExecutionHostId } from '../../shared/execution-host'

const aiVaultAgentSet = new Set<string>(AI_VAULT_AGENTS)

export function isAiVaultAgent(agent: string): agent is AiVaultAgent {
  return aiVaultAgentSet.has(agent)
}

const nodePlatformSchema = z.enum([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
] satisfies NodeJS.Platform[])

const executionHostIdSchema = ScalarString.transform((value, ctx) => {
  const normalized = normalizeExecutionHostId(value)
  if (normalized) {
    return normalized
  }
  ctx.addIssue({ code: 'custom', message: 'Invalid execution host id' })
  return z.NEVER
})

const sessionPreviewMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
  text: ScalarString,
  timestamp: ScalarNullableString
})

const aiVaultSessionSchema = z.object({
  id: ScalarString,
  executionHostId: executionHostIdSchema,
  executionHostPlatform: nodePlatformSchema.nullable().optional(),
  agent: ScalarNonemptyString,
  sessionId: ScalarString,
  title: ScalarString,
  cwd: ScalarNullableString,
  // Malformed aliases must not discard the entire session.
  cwdAliases: z
    .array(ScalarNonemptyString.max(4096))
    .max(AI_VAULT_SCOPE_PATHS_MAX_COUNT)
    .optional()
    .catch(undefined),
  branch: ScalarNullableString,
  model: ScalarNullableString,
  filePath: ScalarString,
  codexHome: ScalarNullableString,
  createdAt: ScalarNullableString,
  updatedAt: ScalarNullableString,
  modifiedAt: ScalarString,
  messageCount: ScalarNumber,
  totalTokens: ScalarNumber,
  previewMessages: z.array(sessionPreviewMessageSchema),
  previewMessagesTruncated: ScalarOptionalBoolean,
  firstUserPrompt: ScalarOptionalNullableString,
  lastUserPrompt: ScalarOptionalNullableString,
  queuedMessageCount: ScalarNumber.default(0),
  subagentTranscriptCount: ScalarNumber.default(0),
  resumeCommand: ScalarString,
  structuredSession: z
    .object({
      sessionId: ScalarNonemptyString.max(512),
      workspaceId: ScalarNonemptyString.max(512)
    })
    .optional(),
  subagent: z
    .object({
      parentSessionId: ScalarString,
      agentType: ScalarNullableString,
      status: z.enum(['running', 'completed', 'failed', 'stopped']).nullable()
    })
    .nullable()
    .default(null)
})

const aiVaultScanIssueSchema = z.object({
  executionHostId: executionHostIdSchema.optional(),
  agent: ScalarNonemptyString,
  // Future issue kinds degrade to scope banners; preserve absent kinds for skipped-transcript rows (#15036).
  kind: z
    .union([z.enum(['host', 'scope', 'notice']), ScalarString.transform(() => 'scope' as const)])
    .optional(),
  path: ScalarString,
  message: ScalarString
})

const aiVaultListResultEnvelopeSchema = z
  .object({
    sessions: z.array(ScalarUnknown),
    issues: z.array(ScalarUnknown),
    scannedAt: ScalarString,
    fingerprint: ScalarString.regex(/^[0-9a-f]{64}$/).optional(),
    unchanged: z.literal(true).optional()
  })
  .refine(
    (value) =>
      !value.unchanged ||
      (value.fingerprint !== undefined && value.sessions.length === 0 && value.issues.length === 0),
    'Invalid unchanged response'
  )

export function parseAiVaultListResult(value: unknown): AiVaultListResult {
  const envelope = aiVaultListResultEnvelopeSchema.safeParse(value)
  if (!envelope.success) {
    throw new Error(envelope.error.issues[0]?.message ?? 'unexpected result shape')
  }
  const sessions: AiVaultSession[] = []
  let malformedSessionCount = 0
  let wellFormedSessionCount = 0
  for (const session of envelope.data.sessions) {
    const parsed = aiVaultSessionSchema.safeParse(session)
    if (!parsed.success) {
      malformedSessionCount += 1
      continue
    }
    wellFormedSessionCount += 1
    if (!isAiVaultAgent(parsed.data.agent)) {
      continue
    }
    sessions.push({ ...parsed.data, agent: parsed.data.agent })
  }
  if (
    envelope.data.sessions.length > 0 &&
    malformedSessionCount > 0 &&
    wellFormedSessionCount === 0
  ) {
    throw new Error('all supplied Agent Session History sessions were invalid')
  }
  const issues: AiVaultScanIssue[] = []
  let malformedIssueCount = 0
  for (const issue of envelope.data.issues) {
    const parsed = aiVaultScanIssueSchema.safeParse(issue)
    if (!parsed.success) {
      malformedIssueCount += 1
      continue
    }
    if (!isAiVaultAgent(parsed.data.agent)) {
      continue
    }
    issues.push({ ...parsed.data, agent: parsed.data.agent })
  }
  const invalidCount = malformedSessionCount + malformedIssueCount
  if (invalidCount > 0) {
    issues.push({
      agent: 'codex',
      path: 'aiVault.listSessions',
      message: `Skipped ${invalidCount} invalid Agent Session History result ${invalidCount === 1 ? 'entry' : 'entries'}.`
    })
  }
  return {
    sessions,
    issues,
    scannedAt: envelope.data.scannedAt,
    ...(envelope.data.fingerprint ? { fingerprint: envelope.data.fingerprint } : {}),
    ...(envelope.data.unchanged ? { unchanged: true as const } : {})
  }
}
