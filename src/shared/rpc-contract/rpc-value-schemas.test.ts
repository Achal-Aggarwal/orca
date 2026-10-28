import { describe, expect, it } from 'vitest'
import { compile, z } from 'zod'
import { GitDiff, GitStatusParams } from './git-params'
import { Issue, IssueComment } from './github-issue-params'
import { ProjectViewTable } from './github-project-params'
import { RpcBoolean, RpcNumber, RpcOptionalBoolean, RpcString } from './rpc-value-schemas'

describe('RPC value schemas', () => {
  it('shares plain value schemas across independent request fields', () => {
    expect(GitDiff.shape.staged).toBe(RpcBoolean)
    expect(GitStatusParams.shape.includeIgnored).toBe(RpcOptionalBoolean)
    expect(GitStatusParams.shape.reuseLineStats).toBe(RpcOptionalBoolean)
  })

  it('shares complete positive integer constraints across request declarations', () => {
    expect(Issue.shape.number).toBe(IssueComment.shape.number)
    expect(Issue.shape.number).toBe(ProjectViewTable.shape.projectNumber)
    expect(ProjectViewTable.shape.viewNumber.unwrap()).toBe(Issue.shape.number)
    expect(Issue.shape.number.safeParse(0).success).toBe(false)
    expect(Issue.shape.number.safeParse(1.5).success).toBe(false)
    expect(Issue.shape.number.parse(1)).toBe(1)
    expect(ProjectViewTable.shape.viewNumber.parse(undefined)).toBeUndefined()
  })

  it('keeps field constraints and optionality separate from shared values', () => {
    const constrained = z.object({
      label: RpcString.min(3, 'Label too short'),
      count: RpcNumber.int().positive(),
      enabled: RpcBoolean.optional()
    })
    expect(constrained.safeParse({ label: 'x', count: 1.5 }).success).toBe(false)
    expect(constrained.parse({ label: 'valid', count: 1 })).toEqual({ label: 'valid', count: 1 })
    expect(RpcString.parse('')).toBe('')
    expect(RpcNumber.parse(1.5)).toBe(1.5)
    expect(RpcBoolean.safeParse(undefined).success).toBe(false)
  })

  it.each([false, true])('keeps issue paths request-local with compilation=%s', (compiled) => {
    const schema = z.object({ left: RpcString, right: z.array(RpcString) })
    const parser = compiled ? compile(schema) : schema
    const first = parser.safeParse({ left: 1, right: ['valid', false] })
    const second = parser.safeParse({ left: 'valid', right: [null] })
    expect(first.success).toBe(false)
    expect(second.success).toBe(false)
    if (first.success || second.success) {
      throw new Error('Invalid values passed validation')
    }
    expect(first.error.issues.map((issue) => issue.path)).toEqual([['left'], ['right', 1]])
    expect(second.error.issues.map((issue) => issue.path)).toEqual([['right', 0]])
    expect(first.error.issues.map((issue) => issue.path)).toEqual([['left'], ['right', 1]])
  })
})
