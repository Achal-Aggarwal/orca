import { ScalarBoolean, ScalarString } from './scalar-value-schemas'
import { z } from 'zod'

const properties = {
  system_language: ScalarString.max(128).nullable(),
  system_language_supported: ScalarBoolean,
  detection_source: z.enum(['native', 'browser', 'browser-fallback']),
  effective_language: ScalarString.max(256)
}

export const onboardingLanguagePickerOpenedSchema = z.object(properties).strict()
export const onboardingLanguageChangedSchema = z
  .object({
    ...properties,
    selected_language: ScalarString.max(256)
  })
  .strict()
export const onboardingLanguageRequestedSchema = z.object(properties).strict()
