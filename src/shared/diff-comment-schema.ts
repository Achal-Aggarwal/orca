import {
  ScalarFiniteNumber,
  ScalarOptionalFiniteNumber,
  ScalarOptionalPositiveInteger,
  ScalarOptionalString,
  ScalarPositiveInteger,
  ScalarString
} from './scalar-value-schemas'
import { z } from 'zod'

export const MobileDiffReviewSchema = z.object({
  version: z.literal(1),
  updatedAt: ScalarOptionalFiniteNumber,
  completedAt: ScalarOptionalFiniteNumber,
  files: z.record(
    ScalarString,
    z.object({
      key: ScalarString,
      filePath: ScalarString,
      oldPath: ScalarOptionalString,
      scope: z.enum(['unstaged', 'staged', 'branch']),
      lastOpenedAt: ScalarOptionalFiniteNumber,
      lastSeenDiffIdentity: ScalarOptionalString,
      reviewedAt: ScalarOptionalFiniteNumber,
      reviewDiffIdentity: ScalarOptionalString
    })
  )
})

export const DiffCommentSchema = z.object({
  id: ScalarString,
  worktreeId: ScalarString,
  filePath: ScalarString,
  source: z.enum(['diff', 'markdown']).optional(),
  selectedText: ScalarOptionalString,
  startLine: ScalarOptionalPositiveInteger,
  lineNumber: ScalarPositiveInteger,
  body: ScalarString,
  createdAt: ScalarFiniteNumber,
  updatedAt: ScalarOptionalFiniteNumber,
  sentAt: ScalarOptionalFiniteNumber,
  scope: z.enum(['unstaged', 'staged', 'branch']).optional(),
  oldPath: ScalarOptionalString,
  diffIdentity: ScalarOptionalString,
  side: z.literal('modified')
})
