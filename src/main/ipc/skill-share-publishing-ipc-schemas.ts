import { ScalarNonemptyString, ScalarString } from '../../shared/scalar-value-schemas'
import { z } from 'zod'
import { SkillDiscoveryTargetSchema } from '../../shared/skills'

export const skillSharePrepareIpcSchema = z
  .object({
    skillIds: z.array(ScalarNonemptyString.max(4096)).min(1).max(512),
    bundleName: ScalarString.regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/),
    target: SkillDiscoveryTargetSchema.optional(),
    packageId: ScalarNonemptyString.max(128).optional()
  })
  .strict()

export const skillSharePublishIpcSchema = z
  .object({
    preparationId: ScalarString.uuid(),
    releaseNotes: ScalarString.max(10_000)
  })
  .strict()
