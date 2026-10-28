import { describe, expect, it } from 'vitest'
import { compile } from 'zod'
import { DiffCommentSchema, MobileDiffReviewSchema } from './diff-comment-schema'

const comment = {
  id: 'comment',
  worktreeId: 'workspace',
  filePath: 'file.ts',
  lineNumber: 1,
  body: 'Review text',
  createdAt: 1,
  side: 'modified' as const
}

describe('shared scalar review validators', () => {
  it('reuses retained string and integer validators across review fields', () => {
    expect(DiffCommentSchema.shape.filePath).toBe(
      MobileDiffReviewSchema.shape.files.valueType.shape.filePath
    )
    expect(DiffCommentSchema.shape.startLine.unwrap()).toBe(DiffCommentSchema.shape.lineNumber)
    expect(DiffCommentSchema.parse(comment)).toEqual(comment)
  })

  it.each([false, true])('keeps review failures independent with compilation=%s', (compiled) => {
    const parser = compiled ? compile(DiffCommentSchema) : DiffCommentSchema
    const first = parser.safeParse({ ...comment, lineNumber: 0, body: 42 })
    const second = parser.safeParse({ ...comment, createdAt: Number.NaN })
    if (first.success || second.success) {
      throw new Error('Invalid review metadata passed validation')
    }
    expect(first.error.issues.map((issue) => issue.path)).toEqual([['lineNumber'], ['body']])
    expect(second.error.issues.map((issue) => issue.path)).toEqual([['createdAt']])
    expect(first.error.issues.map((issue) => issue.path)).toEqual([['lineNumber'], ['body']])
  })
})
