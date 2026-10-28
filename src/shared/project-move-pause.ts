import { ScalarNonemptyString, ScalarString } from './scalar-value-schemas'
import { z } from 'zod'

export const PROJECT_MOVE_PAUSE_PROTOCOL = 1

export type ProjectMovePauseRequest = { requestId: string; protocol: 1 } & (
  | { phase: 'prepare'; worktreeIds: string[] }
  | { phase: 'persist'; successfulWorktreeIds: string[] }
  | { phase: 'release' }
)

const host = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({ kind: z.literal('environment'), environmentId: ScalarNonemptyString })
])

export const projectMovePauseResponseSchema = z.discriminatedUnion('phase', [
  z.object({
    requestId: ScalarString,
    protocol: z.literal(PROJECT_MOVE_PAUSE_PROTOCOL),
    phase: z.literal('prepare'),
    targets: z.array(
      z.object({ worktreeId: ScalarString, terminalHost: host, chatHosts: z.array(host) })
    )
  }),
  z.object({
    requestId: ScalarString,
    protocol: z.literal(PROJECT_MOVE_PAUSE_PROTOCOL),
    phase: z.literal('persist')
  }),
  z.object({
    requestId: ScalarString,
    protocol: z.literal(PROJECT_MOVE_PAUSE_PROTOCOL),
    phase: z.literal('error'),
    error: ScalarString
  })
])

export type ProjectMovePauseResponse = z.infer<typeof projectMovePauseResponseSchema>
