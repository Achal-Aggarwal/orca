import {
  ScalarNonemptyString,
  ScalarOptionalNonemptyString,
  ScalarOptionalString,
  ScalarPositiveInteger,
  ScalarString
} from './scalar-value-schemas'
import { z } from 'zod'
import { SkillInstallFailureSchema, type SkillInstallFailure } from './skill-install-failure'

export const SkillPackageIdentitySchema = z
  .object({
    packageId: ScalarNonemptyString.max(128),
    versionId: ScalarNonemptyString.max(128),
    packageDigest: ScalarString.regex(/^[a-f0-9]{64}$/),
    archiveSha256: ScalarString.regex(/^[a-f0-9]{64}$/),
    compressedBytes: ScalarPositiveInteger.max(40 * 1024 * 1024)
  })
  .strict()

const SkillInstallIngressSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('download-grant'),
      url: z.url(),
      expiresAt: z.iso.datetime({ offset: true })
    })
    .strict(),
  z.object({ kind: z.literal('staged-upload'), uploadId: ScalarNonemptyString.max(128) }).strict(),
  z.object({ kind: z.literal('local-file'), path: ScalarNonemptyString }).strict()
])

const SkillNameSchema = ScalarString.regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

export const SkillInstallDestinationSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('global'),
      environmentId: ScalarOptionalNonemptyString,
      executionTarget: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('host') }).strict(),
          z.object({ kind: z.literal('wsl'), distro: ScalarNonemptyString }).strict(),
          z.object({ kind: z.literal('ssh'), connectionId: ScalarNonemptyString.max(128) }).strict()
        ])
        .optional()
    })
    .strict(),
  z
    .object({
      scope: z.literal('workspace'),
      worktreeId: ScalarOptionalNonemptyString,
      folderWorkspaceId: ScalarOptionalNonemptyString
    })
    .strict()
    .refine((value) => Boolean(value.worktreeId) !== Boolean(value.folderWorkspaceId))
])

/** Agents the user picked. Absent means every detected agent. */
const SkillInstallProvidersSchema = z.array(ScalarNonemptyString.max(64)).max(64)

export const SkillInstallRequestSchema = z
  .object({
    operationId: ScalarNonemptyString.max(128),
    package: SkillPackageIdentitySchema,
    ingress: SkillInstallIngressSchema,
    destination: SkillInstallDestinationSchema,
    providers: SkillInstallProvidersSchema.optional(),
    conflictResolution: z
      .enum(['replace-unmodified', 'replace-and-discard-local', 'cancel'])
      .optional()
  })
  .strict()

export const SkillInstallPreviewRequestSchema = z
  .object({
    package: SkillPackageIdentitySchema,
    name: SkillNameSchema,
    destination: SkillInstallDestinationSchema
  })
  .strict()

export const SkillRemoveRequestSchema = z
  .object({
    operationId: ScalarNonemptyString.max(128),
    name: SkillNameSchema,
    destination: SkillInstallDestinationSchema,
    conflictResolution: z.enum(['replace-and-discard-local', 'cancel']).optional()
  })
  .strict()

export type SkillInstallRequest = z.infer<typeof SkillInstallRequestSchema>
export type SkillInstallDestination = z.infer<typeof SkillInstallDestinationSchema>
export type SkillPackageIdentity = z.infer<typeof SkillPackageIdentitySchema>
export type SkillInstallPreviewRequest = z.infer<typeof SkillInstallPreviewRequestSchema>
export type SkillRemoveRequest = z.infer<typeof SkillRemoveRequestSchema>

export type SkillInstallPreview = {
  name: string
  packageDigest: string
  destinationIdentity: string
  currentState:
    | 'missing'
    | 'unchanged'
    | 'clean-update'
    | 'modified'
    | 'unowned'
    | 'external-link'
    | 'name-collision'
  providers: {
    provider: string
    topology: 'canonical-copy' | 'provider-alias' | 'independent-copy'
    state: 'ready' | 'missing' | 'conflict'
  }[]
}

export type ManagedSkillInstall = {
  name: string
  packageId: string
  versionId: string
  packageDigest: string
  bundleDigest?: string
  scope: 'global' | 'workspace'
  destinationIdentity: string
  destination: SkillInstallDestination
  providers?: string[]
  installedAt: string
  state: 'unchanged' | 'modified' | 'missing'
}

export const ManagedSkillInstallSchema: z.ZodType<ManagedSkillInstall> = z.object({
  name: SkillNameSchema,
  packageId: ScalarString,
  versionId: ScalarString,
  packageDigest: ScalarString.regex(/^[a-f0-9]{64}$/),
  bundleDigest: ScalarString.regex(/^[a-f0-9]{64}$/).optional(),
  scope: z.enum(['global', 'workspace']),
  destinationIdentity: ScalarString,
  destination: SkillInstallDestinationSchema,
  providers: SkillInstallProvidersSchema.optional(),
  installedAt: ScalarString,
  state: z.enum(['unchanged', 'modified', 'missing'])
})

export const ManagedSkillInstallListSchema = z.array(ManagedSkillInstallSchema).max(2048)

export const SkillInstallPreviewSchema: z.ZodType<SkillInstallPreview> = z.object({
  name: SkillNameSchema,
  packageDigest: ScalarString.regex(/^[a-f0-9]{64}$/),
  destinationIdentity: ScalarString,
  currentState: z.enum([
    'missing',
    'unchanged',
    'clean-update',
    'modified',
    'unowned',
    'external-link',
    'name-collision'
  ]),
  providers: z.array(
    z.object({
      provider: ScalarString,
      topology: z.enum(['canonical-copy', 'provider-alias', 'independent-copy']),
      state: z.enum(['ready', 'missing', 'conflict'])
    })
  )
})

export type SkillPlacementResult = {
  provider: string
  path: string
  topology: 'canonical-copy' | 'provider-alias' | 'independent-copy'
  status: 'installed' | 'unchanged' | 'removed' | 'skipped' | 'failed'
  errorCategory?: string
  failure?: SkillInstallFailure
}

export type SkillInstallResult = {
  operationId: string
  status:
    | 'installed'
    | 'updated'
    | 'unchanged'
    | 'removed'
    | 'conflict'
    | 'partial'
    | 'cancelled'
    | 'failed'
  name: string
  packageDigest: string
  canonicalPath?: string
  placements: SkillPlacementResult[]
  conflict?: {
    kind: 'modified' | 'unowned' | 'external-link' | 'name-collision'
    existingDigest?: string
  }
  errorCategory?: string
  failure?: SkillInstallFailure
}

export const SkillInstallResultSchema: z.ZodType<SkillInstallResult> = z.object({
  operationId: ScalarString,
  status: z.enum([
    'installed',
    'updated',
    'unchanged',
    'removed',
    'conflict',
    'partial',
    'cancelled',
    'failed'
  ]),
  name: ScalarString,
  packageDigest: ScalarString,
  canonicalPath: ScalarOptionalString,
  placements: z.array(
    z.object({
      provider: ScalarString,
      path: ScalarString,
      topology: z.enum(['canonical-copy', 'provider-alias', 'independent-copy']),
      status: z.enum(['installed', 'unchanged', 'removed', 'skipped', 'failed']),
      errorCategory: ScalarOptionalString,
      failure: SkillInstallFailureSchema.optional()
    })
  ),
  conflict: z
    .object({
      kind: z.enum(['modified', 'unowned', 'external-link', 'name-collision']),
      existingDigest: ScalarOptionalString
    })
    .optional(),
  errorCategory: ScalarOptionalString,
  failure: SkillInstallFailureSchema.optional()
})
