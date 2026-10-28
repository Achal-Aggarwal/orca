import { ScalarNullableString, ScalarNumber, ScalarString } from '../scalar-value-schemas'
import { z } from 'zod'

/** Workspaces "Hide sleeping" keeps through a rebind gap; null while sleeping ones are shown. */
const RetentionSchema = z.object({
  retainedIds: z.array(ScalarString),
  retentionDecidedAt: ScalarNumber
})

export const SidebarTemporalSnapshotSchema = z.object({
  revision: ScalarNumber,
  /** The list session the window last began; null until one begins (a headless host). */
  sessionId: ScalarNullableString,
  retention: RetentionSchema.nullable()
})

export type SidebarRetention = z.infer<typeof RetentionSchema>
export type SidebarTemporalSnapshot = z.infer<typeof SidebarTemporalSnapshotSchema>
