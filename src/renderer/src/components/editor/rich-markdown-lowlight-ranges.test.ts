// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it } from 'vitest'
import { RichMarkdownCodeBlockLowlight } from './rich-markdown-lowlight'

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

describe('code block lookup for changed ranges', () => {
  it.each([
    { blocks: 100, editEvery: 1 },
    { blocks: 1000, editEvery: 1 },
    { blocks: 1000, editEvery: 10 }
  ])(
    'walks each document once for $blocks blocks, editing every $editEvery',
    ({ blocks, editEvery }) => {
      const lowlight = createLowlight(common)
      const originalHighlight = lowlight.highlight
      let highlights = 0
      lowlight.highlight = (...args) => {
        highlights += 1
        return originalHighlight(...args)
      }
      const editor = new Editor({
        element: document.createElement('div'),
        extensions: [
          StarterKit.configure({ codeBlock: false, trailingNode: false }),
          RichMarkdownCodeBlockLowlight.configure({ lowlight })
        ],
        content: {
          type: 'doc',
          content: Array.from({ length: blocks }, () => ({
            type: 'codeBlock',
            attrs: { language: 'typescript' },
            content: [{ type: 'text', text: 'const needle = 1;' }]
          }))
        }
      })
      editors.push(editor)
      const plugin = editor.state.plugins.find(
        (candidate) =>
          'key' in candidate &&
          typeof candidate.key === 'string' &&
          candidate.key.startsWith('richMarkdownLowlight$')
      )
      if (!plugin) {
        throw new Error('Missing code block highlighting plugin')
      }
      const state = EditorState.create({ doc: editor.state.doc, plugins: [plugin] })
      const positions: number[] = []
      state.doc.descendants((node, pos) => {
        if (node.type.name === 'codeBlock') {
          positions.push(pos + 1 + 'const '.length)
        }
      })
      const edited = positions.filter((_, index) => index % editEvery === 0)
      const transaction = state.tr
      for (const pos of edited.toReversed()) {
        transaction.insertText('replacement', pos, pos + 'needle'.length)
      }
      const originalWalk = ProseMirrorNode.prototype.nodesBetween
      let documentWalks = 0
      highlights = 0
      ProseMirrorNode.prototype.nodesBetween = function (...args) {
        if (this === state.doc || this === transaction.doc) {
          documentWalks += 1
        }
        return originalWalk.apply(this, args)
      }
      let next: EditorState
      try {
        next = state.apply(transaction)
      } finally {
        ProseMirrorNode.prototype.nodesBetween = originalWalk
      }
      expect(highlights).toBe(edited.length)
      expect(documentWalks).toBe(2)

      const fresh = EditorState.create({ doc: transaction.doc, plugins: [plugin] })
      const actual: unknown = plugin.getState(next)
      const expected: unknown = plugin.getState(fresh)
      if (!(actual instanceof DecorationSet) || !(expected instanceof DecorationSet)) {
        throw new Error('Missing code block decorations')
      }
      expect(actual.find()).toHaveLength(blocks * 2)
      expect(actual.find()).toEqual(expected.find())
    }
  )
})
