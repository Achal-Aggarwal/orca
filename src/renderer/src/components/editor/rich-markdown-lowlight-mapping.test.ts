// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { StepMap } from '@tiptap/pm/transform'
import { DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it } from 'vitest'
import { RichMarkdownCodeBlockLowlight } from './rich-markdown-lowlight'

const editors: Editor[] = []

function createEditor(blocks: number): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      RichMarkdownCodeBlockLowlight.configure({ lowlight: createLowlight(common) })
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
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

describe('code block decoration mapping', () => {
  it.each([
    { blocks: 100, editEvery: 1 },
    { blocks: 1000, editEvery: 1 },
    { blocks: 1000, editEvery: 10 }
  ])(
    'discards stale spans before mapping $blocks code blocks, editing every $editEvery',
    ({ blocks, editEvery }) => {
      const editor = createEditor(blocks)
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
      const transaction = state.tr
      const edited = positions.filter((_, index) => index % editEvery === 0)
      for (const pos of edited.toReversed()) {
        transaction.insertText('replacement', pos, pos + 'needle'.length)
      }
      const originalMap = StepMap.prototype.map
      let mapCalls = 0
      StepMap.prototype.map = function (pos, assoc) {
        mapCalls += 1
        return originalMap.call(this, pos, assoc)
      }
      let next: EditorState
      try {
        next = state.apply(transaction)
      } finally {
        StepMap.prototype.map = originalMap
      }

      const fresh = EditorState.create({ doc: transaction.doc, plugins: [plugin] })
      const actual: unknown = plugin.getState(next)
      const expected: unknown = plugin.getState(fresh)
      if (!(actual instanceof DecorationSet) || !(expected instanceof DecorationSet)) {
        throw new Error('Missing code block decorations')
      }
      expect(actual.find()).toHaveLength(blocks * 2)
      expect(actual.find()).toEqual(expected.find())
      expect(mapCalls).toBeLessThanOrEqual(editEvery === 1 ? 0 : edited.length)
    }
  )
})
