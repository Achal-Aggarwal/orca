import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export type MarkdownDocCompletionContext = {
  partial: string
}

export const MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES = 2 * 1024

export function isMarkdownDocCompletionQueryTooLarge(
  query: string,
  maxBytes = MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

function normalizeCompletionText(value: string): string {
  return value.trim().replaceAll('\\', '/').toLowerCase()
}

export function getMarkdownDocCompletionContext(
  linePrefix: string
): MarkdownDocCompletionContext | null {
  const start = linePrefix.lastIndexOf('[[')
  if (start === -1) {
    return null
  }

  if (linePrefix.length - start - 2 > MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES) {
    return null
  }

  const partial = linePrefix.slice(start + 2)
  if (isMarkdownDocCompletionQueryTooLarge(partial)) {
    return null
  }
  if (partial.includes('[') || partial.includes(']') || partial.includes('|')) {
    return null
  }

  return { partial }
}

type MarkdownDocCompletionEntry = {
  document: MarkdownDocument
  name: string
  relativePath: string
}

const completionEntriesByDocuments = new WeakMap<MarkdownDocument[], MarkdownDocCompletionEntry[]>()

function getCompletionEntries(documents: MarkdownDocument[]): MarkdownDocCompletionEntry[] {
  const cached = completionEntriesByDocuments.get(documents)
  if (cached) {
    return cached
  }
  const entries = documents
    .map((document) => ({
      document,
      name: normalizeCompletionText(document.name),
      relativePath: normalizeCompletionText(document.relativePath)
    }))
    .sort((a, b) => a.document.relativePath.localeCompare(b.document.relativePath))
  completionEntriesByDocuments.set(documents, entries)
  return entries
}

export function getMarkdownDocCompletionDocuments(
  documents: MarkdownDocument[],
  partial: string
): MarkdownDocument[] {
  if (isMarkdownDocCompletionQueryTooLarge(partial)) {
    return []
  }

  const normalizedPartial = normalizeCompletionText(partial)
  const matches: MarkdownDocument[] = []
  for (const entry of getCompletionEntries(documents)) {
    if (
      !normalizedPartial ||
      entry.name.startsWith(normalizedPartial) ||
      entry.relativePath.startsWith(normalizedPartial)
    ) {
      matches.push(entry.document)
    }
  }
  return matches
}
