import {
  ScalarBoolean,
  ScalarNonemptyString,
  ScalarNonnegativeInteger,
  ScalarNullableNumber,
  ScalarNullableString,
  ScalarNumber,
  ScalarOptionalBoolean,
  ScalarOptionalNonnegativeInteger,
  ScalarOptionalNumber,
  ScalarOptionalString,
  ScalarString
} from './scalar-value-schemas'
import { resolveSessionSearchLimit, SESSION_SEARCH_LIMIT_MAX } from './ai-vault-search-limit'
import { z } from 'zod'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  AI_VAULT_SEARCH_SORTS
} from './ai-vault-types'
import { AiVaultSearchScopeIdentitySchema } from './ai-vault-search-scope'

// Hosts compare `since` as text against UTC `toISOString()` timestamps, which keep
// milliseconds only; a dropped sub-millisecond remainder rounds up so no earlier session gets in.
function sinceAsStoredInstant(since: string): string {
  const subMillisecond = /\.\d{3}(\d+)/.exec(since)?.[1] ?? ''
  const cutoffMs = Date.parse(since) + (/[1-9]/.test(subMillisecond) ? 1 : 0)
  return new Date(cutoffMs).toISOString()
}

export const AiVaultSearchFiltersSchema = z.object({
  agents: z.array(z.enum(AI_VAULT_AGENTS)).optional(),
  scopePaths: z
    .array(ScalarNonemptyString.max(4096))
    .max(AI_VAULT_SCOPE_PATHS_MAX_COUNT)
    .optional(),
  since: ScalarString.datetime({ offset: true }).transform(sinceAsStoredInstant).optional(),
  sort: z.enum(AI_VAULT_SEARCH_SORTS).optional()
})

// Strip unknown fields so legacy tier/refresh are accepted without affecting the query.
export const AiVaultSearchRequestSchema = z
  .object({
    query: ScalarString,
    scope: z.enum(['conversation', 'all']).optional(),
    freshness: z.enum(['indexed', 'wait-until-current']).optional(),
    limit: ScalarOptionalNumber.transform(resolveSessionSearchLimit),
    cursor: ScalarOptionalString,
    filters: AiVaultSearchFiltersSchema.optional(),
    supportedAgents: z.array(ScalarString).optional(),
    supportsQoderHistory: ScalarOptionalBoolean,
    supportsJcodeHistory: ScalarOptionalBoolean,
    /** Scope by identity, resolved into paths by whichever host answers. */
    within: AiVaultSearchScopeIdentitySchema.optional(),
    debug: ScalarOptionalBoolean
  })
  // Refuse intersecting scopes instead of guessing and widening; neither scope still means all sessions.
  .refine(
    (request) => request.within === undefined || (request.filters?.scopePaths ?? []).length === 0,
    { message: 'A search carries either a scope identity or explicit scope paths, not both' }
  )

export const AiVaultSearchSourceSchema = z.object({
  presence: z.enum(['present', 'unverifiable', 'missing']),
  filePath: ScalarOptionalString,
  codexHome: ScalarOptionalString
})
export const AiVaultSearchEvidenceSchema = z.object({
  snippet: ScalarString,
  role: z.enum(['user', 'assistant', 'tool', 'system', 'unknown']),
  timestamp: ScalarNullableString
})
// Older hosts may omit attribution; the desktop stamps remote answers.
const executionHostIdSchema = ScalarNonemptyString

export const AiVaultSearchHitSchema = z
  .object({
    agent: z.enum(AI_VAULT_AGENTS),
    executionHostId: executionHostIdSchema.optional(),
    sessionId: ScalarString,
    title: ScalarString,
    cwd: ScalarNullableString,
    branch: ScalarNullableString,
    updatedAt: ScalarNullableString,
    messageCount: ScalarNonnegativeInteger,
    score: ScalarNumber,
    source: AiVaultSearchSourceSchema,
    evidence: AiVaultSearchEvidenceSchema.nullable(),
    resumeCommand: ScalarOptionalString,
    /** The native chat owning this transcript, from the indexing host; older hosts omit it. */
    structuredSession: z
      .object({
        sessionId: ScalarNonemptyString.max(512),
        workspaceId: ScalarNonemptyString.max(512)
      })
      .optional()
  })
  .refine((hit) => hit.source.presence === 'present' || hit.resumeCommand === undefined, {
    message: 'Only present sources may have a resume command'
  })
export const AiVaultSearchPageSchema = z.object({
  cursor: ScalarNullableString,
  hasMore: ScalarBoolean
})
export const AiVaultSearchTruncationSchema = z.object({
  candidates: ScalarBoolean,
  snippets: ScalarNonnegativeInteger,
  query: ScalarBoolean,
  freshness: ScalarBoolean
})
/** Desktop-only additive per-host results for all-computers merges; hosts never publish this and older readers drop it. */
export const AiVaultSearchHostOutcomeSchema = z.object({
  executionHostId: executionHostIdSchema,
  outcome: z.enum([
    'searched',
    'stale',
    'disabled',
    'not-ready',
    'no-service',
    'unreachable',
    // This host does not know the workspace or project the scope named.
    'scope-unknown',
    'unsupported-agent'
  ])
})
const routeSchema = z.enum(['phrase', 'and', 'or', 'typo+phrase', 'typo+and', 'typo+or'])
export const AiVaultSearchPlannerReportSchema = z.object({
  route: routeSchema,
  repairedTerms: z.array(ScalarString).optional(),
  scope: z.enum(['conversation', 'all'])
})
export const AiVaultSearchDebugSchema = z.object({
  route: routeSchema,
  repairedTerms: z.array(ScalarString).optional(),
  plannerReport: AiVaultSearchPlannerReportSchema
})
export const AiVaultSearchResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('results'),
    hits: z.array(AiVaultSearchHitSchema).max(SESSION_SEARCH_LIMIT_MAX),
    page: AiVaultSearchPageSchema,
    generation: ScalarNonnegativeInteger,
    truncated: AiVaultSearchTruncationSchema,
    durationMs: ScalarNumber.nonnegative(),
    debug: AiVaultSearchDebugSchema.optional(),
    hosts: z.array(AiVaultSearchHostOutcomeSchema).optional()
  }),
  z.object({
    kind: z.literal('stale-cursor'),
    generation: ScalarNonnegativeInteger,
    expectedGeneration: ScalarOptionalNonnegativeInteger
  }),
  z.object({ kind: z.literal('malformed-cursor') }),
  z.object({
    kind: z.literal('unavailable'),
    // scope-unknown answers only within requests, which older clients cannot send, so they never receive an unknown reason.
    reason: z.enum(['disabled', 'not-ready', 'no-service', 'scope-unknown', 'unsupported-agent'])
  })
])
export const AiVaultSearchStatusRequestSchema = z.object({})
/** Consent flip for one host's index. Answered with that host's status after the change is applied. */
export const AiVaultSetSearchEnabledParamsSchema = z.object({ enabled: ScalarBoolean })
export const AiVaultSearchStatusSchema = z.object({
  // Strings keep a future host's larger catalog readable by this client.
  supportedAgents: z.array(ScalarString).optional(),
  supportsQoderHistory: ScalarOptionalBoolean,
  supportsJcodeHistory: ScalarOptionalBoolean,
  enabled: ScalarBoolean,
  phase: z.enum(['idle', 'indexing', 'current', 'degraded', 'closed']),
  filesIndexed: ScalarNonnegativeInteger,
  filesDue: ScalarNonnegativeInteger,
  filesFailed: ScalarNonnegativeInteger,
  // Optional: a host that predates this field degrades to a session count only.
  messagesIndexed: ScalarOptionalNonnegativeInteger,
  // `root` is a host path, withheld over the relay; the array length is the count.
  degradedRoots: z.array(z.object({ root: ScalarOptionalString, reason: ScalarString })),
  lastReconcileAt: ScalarNullableNumber,
  lastSweepCompletedAt: ScalarNullableNumber,
  // Older hosts omit breakdowns; missing means no breakdown, never zero counts.
  sessionsByAgent: z.record(ScalarString, ScalarNonnegativeInteger).optional(),
  generation: ScalarNonnegativeInteger
})
