import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  isMarkdownPreviewSearchQueryTooLarge,
  type TextMatchOptions
} from './markdown-preview-search'
import {
  findRichMarkdownSearchMatchesInVisibleText,
  type findRichMarkdownSearchMatches,
  type RichMarkdownSearchMatch
} from './rich-markdown-search'
import {
  createRichMarkdownVisibleTextMap,
  type RichMarkdownVisibleTextMap
} from './rich-markdown-visible-text-map'

type CachedMatches = {
  query: string
  matchCase: boolean
  wholeWord: boolean
  matches: RichMarkdownSearchMatch[]
}

type CachedSearchDocument = {
  visibleMap?: RichMarkdownVisibleTextMap
  entries: CachedMatches[]
}

export function createRichMarkdownSearchMatchesCache(): typeof findRichMarkdownSearchMatches {
  let documents = new WeakMap<ProseMirrorNode, CachedSearchDocument>()

  return (doc, query, options: TextMatchOptions = {}, stats) => {
    let cached = documents.get(doc)
    if (!cached) {
      cached = { entries: [] }
      documents = new WeakMap([[doc, cached]])
    }
    const matchCase = options.matchCase ?? false
    const wholeWord = options.wholeWord ?? false
    const existing = cached.entries.find(
      (entry) =>
        entry.query === query && entry.matchCase === matchCase && entry.wholeWord === wholeWord
    )
    if (existing) {
      return existing.matches
    }

    const matches =
      !query || isMarkdownPreviewSearchQueryTooLarge(query)
        ? []
        : findRichMarkdownSearchMatchesInVisibleText(
            (cached.visibleMap ??= createRichMarkdownVisibleTextMap(doc)),
            query,
            options,
            stats
          )
    // The live replacement guard and debounced highlights can have different queries.
    cached.entries = [...cached.entries.slice(-1), { query, matchCase, wholeWord, matches }]
    return matches
  }
}
