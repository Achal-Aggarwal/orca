import { ScalarNumber, ScalarString } from '../scalar-value-schemas'
import { z } from 'zod'

export const WORKSPACE_LIFECYCLE_KINDS = ['create', 'sleep', 'wake', 'close', 'delete'] as const

export type WorkspaceLifecycleKind = (typeof WORKSPACE_LIFECYCLE_KINDS)[number]

/** Accepted lifecycle command hint; transient across restarts. */
const WorkspaceLifecycleHintSchema = z.object({
  kind: z.enum(WORKSPACE_LIFECYCLE_KINDS),
  /** Commands accepted after this one and still waiting. */
  queuedBehind: ScalarNumber,
  /** Last outcome unconfirmed by host; pause the queue pending proof. */
  paused: z.literal(true).optional()
})

/** Keyed by the workspace's host-qualified key (`hostId|id`). */
export const WorkspaceLifecycleHintsSchema = z.record(ScalarString, WorkspaceLifecycleHintSchema)

export type WorkspaceLifecycleHint = z.infer<typeof WorkspaceLifecycleHintSchema>
