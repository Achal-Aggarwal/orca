// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it } from 'vitest'
import { RichMarkdownCodeBlockLowlight } from './rich-markdown-lowlight'

const editors: Editor[] = []

function createEditor(content?: JSONContent) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      RichMarkdownCodeBlockLowlight.configure({ lowlight: createLowlight(common) })
    ],
    content: content ?? {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const value: number = 1' }]
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'prose' }] }
      ]
    }
  })
  editors.push(editor)
  return editor
}

function expectFreshHighlighting(editor: Editor) {
  const fresh = createEditor(editor.getJSON())
  expect(editor.view.dom.innerHTML).toBe(fresh.view.dom.innerHTML)
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

describe('code language changes in mixed transactions', () => {
  it.each(['attribute first', 'text first'])(
    'refreshes a language change with a separate prose edit: %s',
    (order) => {
      const editor = createEditor()
      const initial = editor.view.dom.innerHTML
      const prose = editor.state.doc.child(0).nodeSize + 1
      const tr = editor.state.tr
      if (order === 'attribute first') {
        tr.setNodeAttribute(0, 'language', 'xml').insertText('edited ', prose)
      } else {
        tr.insertText('edited ', prose).setNodeAttribute(0, 'language', 'xml')
      }
      editor.view.dispatch(tr)
      expectFreshHighlighting(editor)
      expect(editor.commands.undo()).toBe(true)
      expect(editor.view.dom.innerHTML).toBe(initial)
      expectFreshHighlighting(editor)
      expect(editor.commands.redo()).toBe(true)
      expectFreshHighlighting(editor)
    }
  )
})
