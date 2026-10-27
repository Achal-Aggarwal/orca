import {
  ROOTED_PATH_START_PATTERN,
  hasPathSeparator,
  trimTerminalPathBoundaryPunctuation,
  type DetectedTerminalFileLinkRange
} from './terminal-file-link-detection-ranges'

// Spaced paths are guesses the host's existence check settles, so a path is never hidden behind prose joined onto it.
const MAX_SPACED_PATH_WORDS = 10
// Why: the path regex stops at `#&=!`, which spaced folder names (`C# Projects`) may contain.
const PATH_WORD_CONTINUATION_REGEX = /[^\s()[\]{}'",;<>|`]*/y
// One single-spaced word; quotes, brackets and list punctuation end a spaced path.
const SPACED_PATH_WORD_REGEX = / ([^\s()[\]{}'",;<>|`]+)/y
const PATH_PART_EXTENSION_PATTERN = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/
const FILENAME_PATTERN = /\.[A-Za-z][A-Za-z0-9_+-]*(?::\d+)?(?::\d+)?$/
// List bullets and shell prompt markers (`~/proj $ git status`) separate a path from what follows.
const SEPARATOR_WORD_PATTERN = /^[·•–—→$%#>❯➜]+$/
const SENTENCE_END_PATTERN = /[.,;:!?]+$/

function endsInFilename(text: string): boolean {
  return FILENAME_PATTERN.test(text.replace(SENTENCE_END_PATTERN, ''))
}

function hasPathPartExtension(text: string): boolean {
  return PATH_PART_EXTENSION_PATTERN.test(text.replace(SENTENCE_END_PATTERN, ''))
}

/** Extends a path across single spaces; keeps words that add a separator or extension, or finish the line. `wordEndIndex` ends the path's own word. */
export function growSpacedPathRanges(
  lineText: string,
  path: DetectedTerminalFileLinkRange,
  rawEndIndex: number
): { ranges: DetectedTerminalFileLinkRange[]; wordEndIndex: number } {
  PATH_WORD_CONTINUATION_REGEX.lastIndex = rawEndIndex
  const continuation = PATH_WORD_CONTINUATION_REGEX.exec(lineText)?.[0] ?? ''
  const wordEndIndex = rawEndIndex + continuation.length
  const promptMarker = SEPARATOR_WORD_PATTERN.test(continuation)
  // Why: a trimmed closer (`(src/a.ts) now`) or a prompt (`~/proj$ cat a.ts`) ends the path; `#` may name a folder (`C# Projects`).
  if (
    /[^.]/.test(lineText.slice(path.endIndex, rawEndIndex)) ||
    (promptMarker && continuation !== '#') ||
    continuation.includes('://')
  ) {
    return { ranges: [], wordEndIndex }
  }
  // Why: unrooted text like `a/b c/d` is usually a list of paths, so it may only grow into a filename.
  const rooted = ROOTED_PATH_START_PATTERN.test(path.text)
  let atFilename = endsInFilename(path.text) || endsInFilename(continuation)
  SPACED_PATH_WORD_REGEX.lastIndex = wordEndIndex
  const words: { endIndex: number; namesPathPart: boolean }[] = []
  let match: RegExpExecArray | null
  while (
    words.length < MAX_SPACED_PATH_WORDS &&
    (match = SPACED_PATH_WORD_REGEX.exec(lineText)) !== null &&
    // Why: `./a.ts ./b.ts` names two paths, `a · b` lists two, and a `scheme://` word starts a URL.
    !ROOTED_PATH_START_PATTERN.test(match[1]) &&
    !SEPARATOR_WORD_PATTERN.test(match[1]) &&
    !match[1].includes('://')
  ) {
    const addsSeparator = hasPathSeparator(match[1])
    const filename = endsInFilename(match[1])
    // Why: a filename ends the path (`notes.md. It covers`) unless a dotted folder continues it (`/tmp/Foo.bar Docs/a.md`).
    if (atFilename && (!rooted || !addsSeparator)) {
      break
    }
    if (!rooted && addsSeparator && !filename) {
      break
    }
    atFilename = filename
    words.push({
      endIndex: SPACED_PATH_WORD_REGEX.lastIndex,
      namesPathPart: rooted ? addsSeparator || hasPathPartExtension(match[1]) : filename
    })
  }
  // oxlint-disable-next-line unicorn/prefer-at -- the phone's terminal WebView (Chrome 74) has no Array#at
  const lastWord = words[words.length - 1]
  // Why: `/etc# ls` is a root prompt, while `/Users/a/My Folder` and `/Users/a/Q&A Docs` are folders.
  const finishesLine =
    rooted &&
    lastWord !== undefined &&
    !promptMarker &&
    lineText.slice(lastWord.endIndex).trim().length === 0
  const ranges: DetectedTerminalFileLinkRange[] = []
  for (const word of words) {
    if (word.namesPathPart || finishesLine) {
      const range = trimTerminalPathBoundaryPunctuation(
        lineText.slice(path.startIndex, word.endIndex),
        path.startIndex
      )
      if (range) {
        ranges.push(range)
      }
    }
  }
  return { ranges, wordEndIndex }
}
