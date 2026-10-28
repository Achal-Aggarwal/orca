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

describe('sparse document-link scans', () => {
  it.each([
    { paragraphs: 100, editEvery: 10 },
    { paragraphs: 1000, editEvery: 10 },
    { paragraphs: 1000, editEvery: 100 }
  ])(
    'walks once for $paragraphs paragraphs, editing every $editEvery',
    ({ paragraphs, editEvery }) => {
      const doc = schema.node(
        'doc',
        null,
        Array.from({ length: paragraphs }, () =>
          schema.node('paragraph', null, schema.text('needle [[Guide|Read guide]] tail'))
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

      const originalNodesBetween = ProseMirrorNode.prototype.nodesBetween
      let rootWalks = 0
      ProseMirrorNode.prototype.nodesBetween = function (from, to, visit, startPos) {
        if (this === transaction.doc) {
          rootWalks += 1
        }
        return originalNodesBetween.call(this, from, to, visit, startPos)
      }
      let next: EditorState
      try {
        next = state.apply(transaction)
      } finally {
        ProseMirrorNode.prototype.nodesBetween = originalNodesBetween
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
      expect(actual.text.find()).toHaveLength(paragraphs)
      let replacedParagraphs = 0
      next.doc.forEach((node) => {
        if (node.textContent.startsWith('replacement')) {
          replacedParagraphs += 1
        }
      })
      expect(replacedParagraphs).toBe(edited.length)
      expect(rootWalks).toBe(2)
    }
  )
})
