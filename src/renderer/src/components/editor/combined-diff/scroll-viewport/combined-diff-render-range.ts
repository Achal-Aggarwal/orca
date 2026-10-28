import type { Range } from '@tanstack/react-virtual'

export function getCombinedDiffRenderRange(
  range: Range,
  estimateHeight: (index: number) => number,
  viewportHeight: number,
  focusedIndex: number | undefined = undefined
): number[] {
  let start = range.startIndex
  let end = range.endIndex
  const budget = Math.max(0, viewportHeight)
  let height = 0
  while (start > 0 && range.startIndex - start < range.overscan) {
    height += estimateHeight(start - 1)
    if (height > budget) {
      break
    }
    start -= 1
  }
  height = 0
  while (end + 1 < range.count && end - range.endIndex < range.overscan) {
    height += estimateHeight(end + 1)
    if (height > budget) {
      break
    }
    end += 1
  }
  const indices = Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
  // Cursor reveal can leave the old extent before deferred section measurements reach the virtualizer.
  if (
    focusedIndex !== undefined &&
    focusedIndex >= 0 &&
    focusedIndex < range.count &&
    !indices.includes(focusedIndex)
  ) {
    indices.push(focusedIndex)
    indices.sort((a, b) => a - b)
  }
  return indices
}

export function getFocusedCombinedDiffSectionIndex(
  viewport: HTMLElement | null
): number | undefined {
  const focused = viewport?.ownerDocument.activeElement
  if (!focused || !viewport?.contains(focused)) {
    return undefined
  }
  const row = focused.closest<HTMLElement>('[data-combined-diff-section-row]')
  const index = row?.dataset.index
  return index === undefined ? undefined : Number(index)
}
