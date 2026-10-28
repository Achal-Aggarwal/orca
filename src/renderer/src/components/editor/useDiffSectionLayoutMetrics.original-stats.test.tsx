// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DiffSection } from './diff-section-types'
import { getLargeDiffRenderLimitFromCounts } from './large-diff-render-limit'
import { useDiffSectionLayoutMetrics } from './useDiffSectionLayoutMetrics'

function section(
  originalContent: string,
  modifiedContent: string,
  status = 'modified'
): DiffSection {
  return {
    key: 'stats',
    path: 'stats.txt',
    status,
    originalContent,
    modifiedContent,
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: null,
    largeDiffRenderLimit: null
  }
}

afterEach(() => vi.restoreAllMocks())

it.each([1000, 10000])(
  'reuses stable original statistics across live modified edits at %i lines',
  (lines) => {
    const original = Array.from({ length: lines }, (_, index) => `original row ${index}`).join('\n')
    let modified = original.replace('original row 0', 'modified row 0')
    let originalUnits = 0
    let modifiedUnits = 0
    const charCodeAt = String.prototype.charCodeAt
    vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function (
      this: string,
      index: number
    ) {
      const content = String(this)
      if (content === original) {
        originalUnits += 1
      }
      if (content === modified) {
        modifiedUnits += 1
      }
      return charCodeAt.call(this, index)
    })
    const view = renderHook(
      ({ value }) => useDiffSectionLayoutMetrics({ section: value, sectionHeight: 300 }),
      {
        initialProps: { value: section(original, modified) }
      }
    )
    expect(view.result.current.lineStats).toEqual({ added: 1, removed: 1 })
    expect(originalUnits).toBe(original.length)
    originalUnits = 0
    modifiedUnits = 0
    view.rerender({ value: section(original, modified) })
    expect(originalUnits).toBe(0)
    expect(modifiedUnits).toBe(0)
    for (let edit = 0; edit < 3; edit += 1) {
      modified = `x${modified}`
      view.rerender({ value: section(original, modified) })
      expect(view.result.current.lineStats).toEqual({ added: 1, removed: 1 })
    }
    expect(originalUnits).toBe(0)
    expect(modifiedUnits).toBe(modified.length * 3 - 3)
  }
)

it('preserves duplicate-line counts, raw line endings, empty content and original replacement', () => {
  const view = renderHook(
    ({ value }) => useDiffSectionLayoutMetrics({ section: value, sectionHeight: 300 }),
    {
      initialProps: { value: section('same\nsame\nother', 'same\nother\nnew') }
    }
  )
  expect(view.result.current.lineStats).toEqual({ added: 1, removed: 1 })
  view.rerender({ value: section('same\nsame\nother', 'same\nsame\nsame\nother') })
  expect(view.result.current.lineStats).toEqual({ added: 1, removed: 0 })
  view.rerender({ value: section('same\nsame\nother', '') })
  expect(view.result.current.lineStats).toEqual({ added: 1, removed: 3 })
  view.rerender({ value: section('a\r\nb', 'a\nb') })
  expect(view.result.current.lineStats).toEqual({ added: 1, removed: 1 })
  view.rerender({ value: section('same\nother\nnew', 'same\nother\nnew') })
  expect(view.result.current.lineStats).toEqual({ added: 0, removed: 0 })
  view.rerender({ value: section('same\nother\nnew', '', 'deleted') })
  expect(view.result.current.lineStats).toEqual({ added: 0, removed: 3 })
  view.rerender({ value: section('', '', 'added') })
  expect(view.result.current.lineStats).toEqual({ added: 0, removed: 0 })
})

it('keeps loading, error, render-limit and oversized gates ahead of original preprocessing', () => {
  const original = 'original\n'.repeat(1000)
  let reads = 0
  const charCodeAt = String.prototype.charCodeAt
  vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function (
    this: string,
    index: number
  ) {
    if (String(this) === original) {
      reads += 1
    }
    return charCodeAt.call(this, index)
  })
  const view = renderHook(
    ({ value }) => useDiffSectionLayoutMetrics({ section: value, sectionHeight: 300 }),
    {
      initialProps: { value: { ...section(original, 'modified'), loading: true } }
    }
  )
  expect(view.result.current.lineStats).toBeNull()
  expect(reads).toBe(0)
  view.rerender({
    value: { ...section(original, 'modified'), error: 'unavailable', loading: false }
  })
  expect(view.result.current.lineStats).toBeNull()
  expect(reads).toBe(0)
  view.rerender({
    value: {
      ...section(original, 'modified'),
      loading: false,
      largeDiffRenderLimit: getLargeDiffRenderLimitFromCounts({
        originalLineCount: 1001,
        modifiedLineCount: 1,
        originalCharacterCount: original.length,
        modifiedCharacterCount: 7000000
      })
    }
  })
  expect(view.result.current.isLargeDiffLimited).toBe(true)
  expect(view.result.current.lineStats).toBeNull()
  expect(reads).toBe(0)
  view.rerender({ value: { ...section(original, 'x'.repeat(500000)), loading: false } })
  expect(view.result.current.lineStats).toBeNull()
  expect(reads).toBe(0)
  view.rerender({ value: { ...section(original, 'modified'), loading: false } })
  expect(view.result.current.lineStats).toEqual({ added: 1, removed: 1001 })
  expect(reads).toBe(original.length)
})
