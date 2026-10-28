import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { StepMap } from '@tiptap/pm/transform'
import { describe, expect, it } from 'vitest'
import { createDocLinkPreviewPlugin } from './rich-markdown-doc-link-decorations'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    markdownDocLink: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { target: { default: '' }, label: { default: null } }
    },
    text: { group: 'inline' }
  }
})

describe('full document-link index rebuilds', () => {
  it.each([
    { paragraphs: 100, kind: 'atoms' },
    { paragraphs: 1000, kind: 'atoms' },
    { paragraphs: 100, kind: 'text' },
    { paragraphs: 1000, kind: 'text' }
  ] as const)('rebuilds $kind after $paragraphs changed paragraphs', ({ paragraphs, kind }) => {
    const doc = schema.node(
      'doc',
      null,
      Array.from({ length: paragraphs }, () =>
        schema.node(
          'paragraph',
          null,
          kind === 'atoms'
            ? [
                schema.text('needle '),
                schema.node('markdownDocLink', { target: 'Guide' }),
                schema.text(' tail')
              ]
            : schema.text('needle [[Guide|Read guide]] tail')
        )
      )
    )
    const plugin = createDocLinkPreviewPlugin({
      documents: [],
      _cachedDocs: null,
      _cachedIndex: null
    })
    const state = EditorState.create({ doc, plugins: [plugin] })
    const positions: number[] = []
    doc.descendants((node, pos) => {
      if (node.isTextblock) {
        positions.push(pos + 1)
      }
    })
    const transaction = state.tr
    for (const pos of positions.toReversed()) {
      transaction.insertText('replacement', pos, pos + 'needle'.length)
    }
    transaction.setSelection(TextSelection.create(transaction.doc, 1))

    const originalMap = StepMap.prototype.map
    const originalMapResult = StepMap.prototype.mapResult
    let mapCalls = 0
    let mapResultCalls = 0
    StepMap.prototype.map = function (position, assoc) {
      mapCalls += 1
      return originalMap.call(this, position, assoc)
    }
    StepMap.prototype.mapResult = function (position, assoc) {
      mapResultCalls += 1
      return originalMapResult.call(this, position, assoc)
    }
    let next: EditorState
    try {
      next = state.apply(transaction)
    } finally {
      StepMap.prototype.map = originalMap
      StepMap.prototype.mapResult = originalMapResult
    }
    const fresh = EditorState.create({
      doc: transaction.doc,
      selection: next.selection,
      plugins: [plugin]
    })
    const actual = plugin.getState(next)
    const expected = plugin.getState(fresh)
    if (!actual || !expected) {
      throw new Error('Missing document-link index')
    }
    expect(actual.atoms.find()).toEqual(expected.atoms.find())
    expect(actual.text.find()).toEqual(expected.text.find())
    expect(actual.preview.find()).toEqual(expected.preview.find())
    expect(actual[kind].find()).toHaveLength(paragraphs)
    next.doc.forEach((node) => {
      expect(node.textContent.startsWith('replacement')).toBe(true)
    })
    expect(mapCalls).toBe(0)
    expect(mapResultCalls).toBe(0)
  })
})
