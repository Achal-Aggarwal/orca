// @vitest-environment happy-dom
import { defaultRangeExtractor } from '@tanstack/react-virtual'
import { describe, expect, it, vi } from 'vitest'
import {
  getCombinedDiffRenderRange,
  includeFocusedCombinedDiffSection,
  getFocusedCombinedDiffSectionIndex
} from './combined-diff-render-range'

describe('combined diff render range', () => {
  it('keeps visible large sections without mounting their large neighbors', () => {
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 2, endIndex: 3, count: 8, overscan: 5 },
        () => 230_000,
        800
      )
    ).toEqual([2, 3])
  })

  it('stops at a large neighboring section instead of skipping across it', () => {
    const heights = [100, 230_000, 100, 100, 230_000, 100]
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 2, endIndex: 2, count: heights.length, overscan: 5 },
        (index) => heights[index],
        800
      )
    ).toEqual([2, 3])
  })
})

it.each([100, 1000])(
  'bounds neighbor work and retains only the focused owner with %i rows',
  (count) => {
    const viewport = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.combinedDiffSectionRow = ''
    row.dataset.index = '2'
    const input = document.createElement('input')
    row.append(input)
    viewport.append(row)
    document.body.append(viewport)
    try {
      input.focus()
      const estimate = vi.fn(() => 50)
      const range = { startIndex: 40, endIndex: 42, count, overscan: 5 }
      const extract = () =>
        getCombinedDiffRenderRange(
          range,
          estimate,
          300,
          getFocusedCombinedDiffSectionIndex(viewport)
        )
      const visible = Array.from({ length: 13 }, (_, index) => 35 + index)
      expect(extract()).toEqual([2, ...visible])
      expect(estimate).toHaveBeenCalledTimes(10)
      expect(
        includeFocusedCombinedDiffSection(
          defaultRangeExtractor(range),
          count,
          getFocusedCombinedDiffSectionIndex(viewport)
        )
      ).toEqual([2, ...visible])
      input.blur()
      estimate.mockClear()
      expect(extract()).toEqual(visible)
      expect(
        includeFocusedCombinedDiffSection(
          defaultRangeExtractor(range),
          count,
          getFocusedCombinedDiffSectionIndex(viewport)
        )
      ).toEqual(visible)
      expect(estimate).toHaveBeenCalledTimes(10)
    } finally {
      viewport.remove()
    }
  }
)
