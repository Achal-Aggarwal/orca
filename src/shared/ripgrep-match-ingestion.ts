import type { RipgrepMatchMessage } from './ripgrep-dense-match-json'
import type { SearchAccumulator } from './text-search'
import { pushSearchMatch } from './text-search-match-accumulator'
import {
  normalizeRelativePath,
  relativeToSearchRoot,
  resolveSearchResultPath
} from './text-search-paths'
import { ripgrepMatchRanges } from './ripgrep-match-offsets'
import { decodeRipgrepLine } from './ripgrep-line-decoding'

export function ingestRgMatchMessage(
  msg: RipgrepMatchMessage,
  rootPath: string,
  acc: SearchAccumulator,
  maxResults: number,
  transformAbsPath?: (p: string) => string | null
): 'continue' | 'stop' {
  if (acc.totalMatches >= maxResults) {
    return 'stop'
  }
  if (msg.type !== 'match' || !msg.data) {
    return 'continue'
  }
  const data = msg.data
  const rawPath = data.path?.text
  if (typeof rawPath !== 'string') {
    // File APIs accept strings, so byte-only filenames cannot be opened losslessly.
    acc.truncated = true
    return 'continue'
  }
  const mappedPath = transformAbsPath ? transformAbsPath(rawPath) : rawPath
  if (mappedPath === null) {
    acc.truncated = true
    return 'continue'
  }
  const absPath = resolveSearchResultPath(rootPath, mappedPath)
  const relPath = normalizeRelativePath(relativeToSearchRoot(rootPath, absPath), rootPath)
  const { text: lineContent, readOffset } = decodeRipgrepLine(data.lines)
  const lineNumber = data.line_number ?? 0
  for (const sub of ripgrepMatchRanges(lineContent, data.submatches ?? [], readOffset, () => {
    acc.truncated = true
  })) {
    let fileResult = acc.fileMap.get(absPath)
    if (!fileResult) {
      fileResult = { filePath: absPath, relativePath: relPath, matches: [], matchCount: 0 }
      acc.fileMap.set(absPath, fileResult)
    }
    if (
      pushSearchMatch({
        fileResult,
        accumulator: acc,
        lineContent,
        matchStart: sub.start,
        matchLength: sub.end - sub.start,
        lineNumber,
        maxResults
      }) === 'stop'
    ) {
      return 'stop'
    }
  }
  return 'continue'
}
