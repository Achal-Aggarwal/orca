import { ScalarNonemptyString } from '../scalar-value-schemas'
import { z } from 'zod'

/** Bind desktop/serve consent writes to the exact reviewed manifest fingerprint, never just the currently installed key. */
export const pluginConsentRequestSchema = z
  .object({
    pluginKey: ScalarNonemptyString,
    reviewedFingerprint: ScalarNonemptyString.max(256),
    decision: z.enum(['approve', 'keep-disabled'])
  })
  .strict()

export type PluginConsentRequest = z.infer<typeof pluginConsentRequestSchema>
