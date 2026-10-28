export type DiffLineStats = { added: number; removed: number }

/** Approximate added/removed counts by matching line multiplicities, without computing an ordered diff. */
export function computeLineStats(
  original: string,
  modified: string,
  status: string
): DiffLineStats | null {
  return createDiffLineStatsCalculator(original)(modified, status)
}

export function createDiffLineStatsCalculator(
  original: string
): (modified: string, status: string) => DiffLineStats | null {
  let originalLineCounts: Map<string, number> | null = null
  let originalLineCount = 0

  return (modified, status) => {
    // Keep original preprocessing behind the same render-time size and status gates.
    if (original.length + modified.length > 500_000) {
      return null
    }
    if (status === 'added') {
      return { added: modified ? countLinesWithoutAllocation(modified) : 0, removed: 0 }
    }
    if (status === 'deleted') {
      return { added: 0, removed: original ? countLinesWithoutAllocation(original) : 0 }
    }

    if (!originalLineCounts) {
      originalLineCounts = new Map<string, number>()
      originalLineCount = countDiffLinesIntoMultiset(original, originalLineCounts)
    }
    const originalCounts = originalLineCounts
    const matchedLineCounts = new Map<string, number>()
    let modifiedLineCount = 0
    let matched = 0

    forEachDiffLine(modified, (line) => {
      modifiedLineCount += 1
      const available = originalCounts.get(line) ?? 0
      if (available === 0) {
        return
      }
      const consumed = matchedLineCounts.get(line) ?? 0
      if (consumed < available) {
        matchedLineCounts.set(line, consumed + 1)
        matched += 1
      }
    })

    return {
      added: modifiedLineCount - matched,
      removed: originalLineCount - matched
    }
  }
}

function countDiffLinesIntoMultiset(content: string, lineCounts: Map<string, number>): number {
  let lineCount = 0
  forEachDiffLine(content, (line) => {
    lineCount += 1
    lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1)
  })
  return lineCount
}

function countLinesWithoutAllocation(content: string): number {
  let lineCount = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1
    }
  }
  return lineCount
}

function forEachDiffLine(content: string, visit: (line: string) => void): void {
  let lineStart = 0
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    visit(content.slice(lineStart, index))
    lineStart = index + 1
  }
}
