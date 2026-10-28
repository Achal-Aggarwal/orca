import {
  ScalarOptionalBoolean,
  ScalarOptionalNullableString,
  ScalarOptionalString,
  ScalarString
} from './scalar-value-schemas'
import { z } from 'zod'

export const persistedOpenFileSchema = z.object({
  filePath: ScalarString,
  relativePath: ScalarString,
  worktreeId: ScalarString,
  language: ScalarString,
  isPreview: ScalarOptionalBoolean,
  runtimeEnvironmentId: ScalarOptionalNullableString,
  mirroredFromRuntimeSession: z.literal(true).optional(),
  externalSshTargetId: ScalarString.trim().min(1).optional(),
  dirtyDraftContent: ScalarOptionalString,
  lastKnownDiskSignature: ScalarOptionalString,
  readOnly: ScalarOptionalBoolean,
  liveTail: ScalarOptionalBoolean
})
