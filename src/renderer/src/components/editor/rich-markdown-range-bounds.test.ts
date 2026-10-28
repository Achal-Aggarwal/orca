import { describe, expect, it } from 'vitest'
import {
  getRichMarkdownLineBlockAtLine,
  getRichMarkdownLineRangeFromBlocks,
  getRichMarkdownRangeBounds,
  getRichMarkdownRangeStart
} from './rich-markdown-range-bounds'

describe('rich markdown range bounds', () => {
  it('locates source line blocks without scanning every preceding block', () => {
    let visits = 0
    const blocks = Array.from({ length: 1_000 }, (_, index) => ({
      get startLine() {
        visits += 1
        return 3 * index + 1
      },
      endLine: 3 * index + 2
    }))
    expect(getRichMarkdownLineBlockAtLine(blocks, 2_999)).toBe(blocks[999])
    expect(visits).toBeLessThanOrEqual(10)
    expect(getRichMarkdownLineBlockAtLine(blocks, 3)).toBeUndefined()
    expect(getRichMarkdownLineBlockAtLine(blocks, 0)).toBeUndefined()
    expect(getRichMarkdownLineBlockAtLine(blocks, Number.NaN)).toBeUndefined()
    expect(getRichMarkdownLineBlockAtLine([], 1)).toBeUndefined()
  })

  it('finds selected line bounds without spreading block arrays', () => {
    const blocks = Array.from({ length: 130_000 }, (_, index) => ({
      startLine: index + 1,
      endLine: index + 1
    }))

    expect(getRichMarkdownLineRangeFromBlocks(blocks)).toEqual({
      startLine: 1,
      lineNumber: 130_000
    })
  })

  it('finds annotation range bounds without spreading range arrays', () => {
    const ranges = Array.from({ length: 130_000 }, (_, index) => ({
      from: index + 10,
      to: index + 11
    }))
    ranges.push({ from: 3, to: 2 })
    ranges.push({ from: 200_000, to: 199_999 })

    expect(getRichMarkdownRangeStart(ranges)).toBe(2)
    expect(getRichMarkdownRangeBounds(ranges)).toEqual({
      from: 2,
      to: 200_000
    })
  })
})
