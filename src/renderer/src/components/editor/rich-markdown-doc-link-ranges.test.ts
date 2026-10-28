import { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { createDocLinkPreviewPlugin } from './rich-markdown-doc-link-decorations'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {}
  }
})

describe('document link textblock ranges', () => {
  it.each([
    { paragraphs: 100, editEvery: 1 },
    { paragraphs: 1000, editEvery: 1 },
    { paragraphs: 1000, editEvery: 10 }
  ])(
    'avoids repeated endpoint resolution for $paragraphs paragraphs, editing every $editEvery',
    ({ paragraphs, editEvery }) => {
      const doc = schema.node(
        'doc',
        null,
        Array.from({ length: paragraphs }, () =>
          schema.node('paragraph', null, schema.text('needle ordinary text'))
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
      const edited = positions.filter((_, index) => index % editEvery === 0)
      const transaction = state.tr
      for (const pos of edited.toReversed()) {
        transaction.insertText('replacement', pos, pos + 'needle'.length)
      }
      transaction.setSelection(TextSelection.create(transaction.doc, 1))

      const originalResolve = ProseMirrorNode.prototype.resolve
      let endpointResolutions = 0
      ProseMirrorNode.prototype.resolve = function (pos) {
        if (this === transaction.doc) {
          endpointResolutions += 1
        }
        return originalResolve.call(this, pos)
      }
      let next: EditorState
      try {
        next = state.apply(transaction)
      } finally {
        ProseMirrorNode.prototype.resolve = originalResolve
      }
      const fresh = EditorState.create({
        doc: transaction.doc,
        selection: next.selection,
        plugins: [plugin]
      })
      const actual = plugin.getState(next)
      const expected = plugin.getState(fresh)
      if (!actual || !expected) {
        throw new Error('Missing document link index')
      }
      expect(actual.atoms.find()).toEqual(expected.atoms.find())
      expect(actual.text.find()).toEqual(expected.text.find())
      expect(actual.preview.find()).toEqual(expected.preview.find())
      let replacedParagraphs = 0
      next.doc.forEach((node) => {
        if (node.textContent.startsWith('replacement')) {
          replacedParagraphs += 1
        }
      })
      expect(replacedParagraphs).toBe(edited.length)
      expect(endpointResolutions).toBe(0)
    }
  )
})
