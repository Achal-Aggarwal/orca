import { Schema } from '@tiptap/pm/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findRichMarkdownSearchMatches } from './rich-markdown-search'
import { createRichMarkdownSearchMatchesCache } from './rich-markdown-search-matches-cache'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    reference: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { label: {} },
      leafText: (node) => node.attrs.label
    }
  }
})

function createDoc(count = 1) {
  return schema.node(
    'doc',
    null,
    Array.from({ length: count }, () =>
      schema.node('paragraph', null, schema.text('Alpha beta gamma delta needle.'))
    )
  )
}

afterEach(() => vi.restoreAllMocks())

describe('Find document projection lifetime', () => {
  it.each([100, 1_000])('projects %i paragraphs once across settled queries', (count) => {
    const doc = createDoc(count)
    const queries = ['a', 'al', 'alp', 'alpha']
    const expected = queries.map((query) => findRichMarkdownSearchMatches(doc, query))
    const walk = vi.spyOn(doc, 'nodesBetween')
    const find = createRichMarkdownSearchMatchesCache()
    expect(queries.map((query) => find(doc, query))).toEqual(expected)
    expect(walk).toHaveBeenCalledTimes(1)
  })

  it('reuses atom text and separators while applying each query and matching option', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Beta '),
        schema.node('reference', { label: 'locked' }),
        schema.text(' betas')
      ]),
      schema.node('paragraph', null, schema.text('beta'))
    ])
    const searches = [
      { query: 'Beta', options: {} },
      { query: 'Beta', options: { matchCase: true } },
      { query: 'beta', options: { wholeWord: true } },
      { query: 'Beta locked', options: {} },
      { query: 'locked', options: { matchCase: true, wholeWord: true } },
      { query: 'betas\nbeta', options: {} }
    ]
    const expected = searches.map(({ query, options }) =>
      findRichMarkdownSearchMatches(doc, query, options)
    )
    const walk = vi.spyOn(doc, 'nodesBetween')
    const find = createRichMarkdownSearchMatchesCache()
    const actual = searches.map(({ query, options }) => find(doc, query, options))
    expect(actual).toEqual(expected)
    expect(actual[3]?.[0]?.touchesReadOnlyAtom).toBe(true)
    expect(actual[5]).toEqual([])
    expect(walk).toHaveBeenCalledTimes(1)
  })

  it('drops the previous projection on document changes and skips invalid queries', () => {
    const doc = createDoc()
    const second = schema.node('doc', null, schema.node('paragraph', null, schema.text('new beta')))
    const walk = vi.spyOn(doc, 'nodesBetween')
    const find = createRichMarkdownSearchMatchesCache()
    expect(find(doc, '')).toEqual([])
    expect(find(doc, 'x'.repeat(2_049))).toEqual([])
    expect(walk).not.toHaveBeenCalled()
    expect(find(doc, 'needle')).toHaveLength(1)
    expect(find(second, 'beta')).toEqual([{ from: 5, to: 9 }])
    expect(find(doc, 'needle')).toHaveLength(1)
    expect(walk).toHaveBeenCalledTimes(2)
  })

  it('does not retain a document after its editor owner releases it', async () => {
    const find = createRichMarkdownSearchMatchesCache()
    function searchRetiredDocument() {
      const doc = createDoc(100)
      expect(find(doc, 'needle')).toHaveLength(100)
      return new WeakRef(doc)
    }
    const retired = searchRetiredDocument()
    if (typeof globalThis.gc !== 'function') {
      throw new Error('Run with the repository Vitest --expose-gc config')
    }
    for (let round = 0; round < 3; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc()
    }
    expect(retired.deref()).toBeUndefined()
    expect(find(createDoc(), 'needle')).toHaveLength(1)
  })
})
