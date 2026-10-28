import {
  ScalarFiniteNumber,
  ScalarNonemptyString,
  ScalarOptionalBoolean,
  ScalarOptionalFiniteNumber,
  ScalarOptionalNonemptyString
} from './scalar-value-schemas'
import { z } from 'zod'
import {
  EphemeralVmRecipeConnectionResultSchema,
  EphemeralVmRecipeLegacyResultSchema,
  EphemeralVmRecipeResultSchema
} from './ephemeral-vm-recipes'

export const EphemeralVmRuntimeStatusSchema = z.enum([
  'provisioning',
  'running',
  'suspended',
  'suspend_failed',
  'resume_failed',
  'failed',
  'cleanup_pending',
  'cleanup_failed',
  'cleaned'
])

export type EphemeralVmRuntimeStatus = z.infer<typeof EphemeralVmRuntimeStatusSchema>

export const EphemeralVmCleanupStatusSchema = z.enum([
  'not_started',
  'disabled',
  'running',
  'succeeded',
  'failed'
])

export type EphemeralVmCleanupStatus = z.infer<typeof EphemeralVmCleanupStatusSchema>

export const EphemeralVmRuntimeConnectionModeSchema = z.enum(['orca-server', 'ssh'])

const EphemeralVmRuntimeRecipeSchema = z
  .object({
    id: ScalarNonemptyString,
    name: ScalarNonemptyString,
    create: ScalarNonemptyString,
    checkoutMode: z.enum(['orca-worktree', 'provisioned-root']).optional(),
    description: ScalarOptionalNonemptyString,
    suspend: ScalarOptionalNonemptyString,
    resume: ScalarOptionalNonemptyString,
    destroy: ScalarOptionalNonemptyString,
    destroyDisabled: ScalarOptionalBoolean
  })
  .strict()

export const EphemeralVmRuntimeRecordSchema = z.object({
  id: ScalarNonemptyString,
  recipeId: ScalarNonemptyString,
  /** Snapshot lifecycle commands so later pack updates/disabling/removal cannot change an existing runtime’s cleanup. */
  recipe: EphemeralVmRuntimeRecipeSchema.optional(),
  repoId: ScalarOptionalNonemptyString,
  projectId: ScalarOptionalNonemptyString,
  workspaceId: ScalarOptionalNonemptyString,
  workspaceName: ScalarOptionalNonemptyString,
  connectionMode: EphemeralVmRuntimeConnectionModeSchema.optional(),
  runtimeEnvironmentId: ScalarOptionalNonemptyString,
  sshTargetId: ScalarOptionalNonemptyString,
  status: EphemeralVmRuntimeStatusSchema,
  cleanupStatus: EphemeralVmCleanupStatusSchema,
  cleanupDisabled: ScalarOptionalBoolean,
  cleanupLastAttemptAt: ScalarOptionalFiniteNumber,
  cleanupLastError: ScalarOptionalNonemptyString,
  createdAt: ScalarFiniteNumber,
  updatedAt: ScalarFiniteNumber,
  recipeResult: EphemeralVmRecipeResultSchema
})

export type EphemeralVmRuntimeRecord = z.infer<typeof EphemeralVmRuntimeRecordSchema>

export const EphemeralVmRuntimeStoreSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(EphemeralVmRuntimeRecordSchema)
})

export type EphemeralVmRuntimeStore = z.infer<typeof EphemeralVmRuntimeStoreSchema>

const RollbackEphemeralVmRuntimeRecipeSchema = z
  .object({
    id: ScalarNonemptyString,
    name: ScalarNonemptyString,
    create: ScalarNonemptyString,
    description: ScalarOptionalNonemptyString,
    suspend: ScalarOptionalNonemptyString,
    resume: ScalarOptionalNonemptyString,
    destroy: ScalarOptionalNonemptyString,
    destroyDisabled: ScalarOptionalBoolean
  })
  .strict()

export const RollbackEphemeralVmRuntimeRecordSchema = EphemeralVmRuntimeRecordSchema.extend({
  recipe: RollbackEphemeralVmRuntimeRecipeSchema.optional(),
  recipeResult: z.union([
    EphemeralVmRecipeLegacyResultSchema,
    EphemeralVmRecipeConnectionResultSchema
  ])
})

export const RollbackEphemeralVmRuntimeStoreSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(RollbackEphemeralVmRuntimeRecordSchema)
})
