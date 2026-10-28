import { ScalarNumber, ScalarOptionalString, ScalarString } from '../scalar-value-schemas'
import { z } from 'zod'

const WorkspaceCreationSchema = z.object({
  repoId: ScalarString,
  /** Set after persistence, before announcement; readers listing this workspace replace its creation without a gap or duplicate. */
  worktreeId: ScalarOptionalString
})

/** Host-running creations by creationId; window preflight stays in its pending layer. */
export const WorkspaceCreationsSnapshotSchema = z.object({
  revision: ScalarNumber,
  creations: z.record(ScalarString, WorkspaceCreationSchema)
})

export type WorkspaceCreation = z.infer<typeof WorkspaceCreationSchema>
export type WorkspaceCreationsSnapshot = z.infer<typeof WorkspaceCreationsSnapshotSchema>
