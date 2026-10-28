import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { Decoration } from '@tiptap/pm/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRichMarkdownSearchPlugin,
  findRichMarkdownSearchMatches,
  richMarkdownSearchPluginKey,
  type RichMarkdownSearchMatch
} from './rich-markdown-search'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    reference: { group: 'inline', inline: true, atom: true, leafText: () => 'cat' }
  }
})

function createState(count: number) {
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('cat '.repeat(count)))
    ]),
    plugins: [createRichMarkdownSearchPlugin()]
  })
}

function setMatches(
  state: EditorState,
  matches: RichMarkdownSearchMatch[],
  activeIndex: number,
  query = 'cat'
) {
  return state.apply(state.tr.setMeta(richMarkdownSearchPluginKey, { activeIndex, matches, query }))
}

function expectFreshDecorations(
  state: EditorState,
  matches: RichMarkdownSearchMatch[],
  activeIndex: number,
  query = 'cat'
) {
  const fresh = setMatches(
    EditorState.create({ schema, doc: state.doc, plugins: [createRichMarkdownSearchPlugin()] }),
    matches,
    activeIndex,
    query
  )
  const decorations = richMarkdownSearchPluginKey.getState(state)!.decorations
  expect(decorations.find()).toEqual(
    richMarkdownSearchPluginKey.getState(fresh)!.decorations.find()
  )
}

afterEach(() => vi.restoreAllMocks())

describe('search highlight navigation', () => {
  it.each([100, 1_000])(
    'replaces only old and new active decorations among %i matches',
    (count) => {
      let state = createState(count)
      const matches = findRichMarkdownSearchMatches(state.doc, 'cat')
      state = setMatches(state, matches, 0)
      const inline = vi.spyOn(Decoration, 'inline')
      state = setMatches(state, matches, count - 1)
      expect(inline).toHaveBeenCalledTimes(2)
      inline.mockClear()
      state = setMatches(state, matches, count - 1)
      expect(inline).not.toHaveBeenCalled()
      expectFreshDecorations(state, matches, count - 1)
      state = setMatches(state, matches, -1)
      expectFreshDecorations(state, matches, -1)
    }
  )

  it('rebuilds authoritative matches after document edits and query changes', () => {
    let state = createState(3)
    let matches = findRichMarkdownSearchMatches(state.doc, 'cat')
    state = setMatches(state, matches, 0)
    state = state.apply(state.tr.insertText('cat ', 1))
    matches = findRichMarkdownSearchMatches(state.doc, 'cat')
    state = setMatches(state, matches, 2)
    expectFreshDecorations(state, matches, 2)
    state = setMatches(state, matches, 1, 'CAT')
    expectFreshDecorations(state, matches, 1, 'CAT')
    state = setMatches(state, [], -1, '')
    expect(richMarkdownSearchPluginKey.getState(state)!.decorations.find()).toEqual([])
  })

  it('preserves node and mixed inline decorations when navigating to visible read-only atoms', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('cat cat '), schema.node('reference')])
      ]),
      plugins: [createRichMarkdownSearchPlugin()]
    })
    const matches = findRichMarkdownSearchMatches(state.doc, 'cat')
    expect(matches).toHaveLength(3)
    state = setMatches(state, matches, 0)
    state = setMatches(state, matches, 2)
    expectFreshDecorations(state, matches, 2)
    state = setMatches(state, matches, 1)
    expectFreshDecorations(state, matches, 1)
  })
})
