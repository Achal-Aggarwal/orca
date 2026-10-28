import { describe, expect, it, vi } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import {
  getMarkdownDocCompletionContext,
  getMarkdownDocCompletionDocuments,
  isMarkdownDocCompletionQueryTooLarge,
  MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES
} from './markdown-doc-completions'

const documents: MarkdownDocument[] = [
  {
    filePath: '/repo/docs/setup.md',
    relativePath: 'docs/setup.md',
    basename: 'setup.md',
    name: 'setup'
  },
  {
    filePath: '/repo/notes/plan.md',
    relativePath: 'notes/plan.md',
    basename: 'plan.md',
    name: 'plan'
  }
]

describe('getMarkdownDocCompletionContext', () => {
  it('detects partial doc links', () => {
    expect(getMarkdownDocCompletionContext('before [[se')).toEqual({ partial: 'se' })
  })

  it('supports an empty partial after opening brackets', () => {
    expect(getMarkdownDocCompletionContext('[[')).toEqual({ partial: '' })
  })

  it('rejects closed or malformed contexts', () => {
    expect(getMarkdownDocCompletionContext('[[done]]')).toBeNull()
    expect(getMarkdownDocCompletionContext('[[done|Alias')).toBeNull()
    expect(getMarkdownDocCompletionContext('plain text')).toBeNull()
  })

  it('rejects oversized pasted partials before opening completions', () => {
    expect(
      getMarkdownDocCompletionContext(
        `[[${'x'.repeat(MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES + 1)}`
      )
    ).toBeNull()
  })
})

describe('getMarkdownDocCompletionDocuments', () => {
  it('filters by name or relative path', () => {
    expect(getMarkdownDocCompletionDocuments(documents, 'do')).toEqual([documents[0]])
    expect(getMarkdownDocCompletionDocuments(documents, 'notes/pl')).toEqual([documents[1]])
  })

  it('normalizes Windows-style partial paths', () => {
    expect(getMarkdownDocCompletionDocuments(documents, 'docs\\se')).toEqual([documents[0]])
  })

  it('reuses catalog preprocessing across queries and rebuilds for a replacement catalog', () => {
    const catalog = [
      { ...documents[1], name: ' Plan ', relativePath: 'notes\\plan.md' },
      { ...documents[0], name: ' SETUP ' }
    ]
    expect(getMarkdownDocCompletionDocuments(catalog, '')).toEqual([catalog[1], catalog[0]])
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    const normalize = vi.spyOn(String.prototype, 'toLowerCase')
    try {
      expect(getMarkdownDocCompletionDocuments(catalog, 'se')).toEqual([catalog[1]])
      expect(getMarkdownDocCompletionDocuments(catalog, 'notes/')).toEqual([catalog[0]])
      expect(getMarkdownDocCompletionDocuments(catalog, 'missing')).toEqual([])
      expect(compare).not.toHaveBeenCalled()
      expect(normalize).toHaveBeenCalledTimes(3)
    } finally {
      compare.mockRestore()
      normalize.mockRestore()
    }
    const replacement = [{ ...catalog[0], name: 'new-plan', relativePath: 'new/new-plan.md' }]
    expect(getMarkdownDocCompletionDocuments(replacement, 'plan')).toEqual([])
    expect(getMarkdownDocCompletionDocuments(replacement, 'new-')).toEqual(replacement)
    expect(catalog.map((document) => document.name)).toEqual([' Plan ', ' SETUP '])
  })

  it('returns no documents for oversized pasted partials before reading documents', () => {
    const unreadableDocument = { ...documents[0] }
    Object.defineProperty(unreadableDocument, 'name', {
      get() {
        throw new Error('document should not be scanned')
      }
    })

    expect(
      getMarkdownDocCompletionDocuments(
        [unreadableDocument],
        'x'.repeat(MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES + 1)
      )
    ).toEqual([])
  })
})

describe('isMarkdownDocCompletionQueryTooLarge', () => {
  it('counts UTF-8 bytes rather than UTF-16 code units', () => {
    expect(
      isMarkdownDocCompletionQueryTooLarge(
        'é'.repeat(MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES / 2 + 1)
      )
    ).toBe(true)
  })
})
