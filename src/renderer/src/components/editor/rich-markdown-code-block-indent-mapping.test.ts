// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { StepMap } from '@tiptap/pm/transform'
import { expect, it, vi } from 'vitest'
import {
  indentRichMarkdownCodeBlock,
  outdentRichMarkdownCodeBlock
} from './rich-markdown-code-block-indent'

it.each(['indent', 'outdent'] as const)(
  'keeps position mapping bounded when %s affects 1000 code lines',
  (direction) => {
    const lines = 1000
    const original = Array(lines)
      .fill(direction === 'indent' ? 'line' : '  line')
      .join('\n')
    const expected = Array(lines)
      .fill(direction === 'indent' ? '  line' : 'line')
      .join('\n')
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [{ type: 'codeBlock', content: [{ type: 'text', text: original }] }]
      }
    })
    try {
      editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 })
      const map = vi.spyOn(StepMap.prototype, 'map')
      let mappingCalls: number
      try {
        const changed =
          direction === 'indent'
            ? indentRichMarkdownCodeBlock(editor)
            : outdentRichMarkdownCodeBlock(editor)
        expect(changed).toBe(true)
        mappingCalls = map.mock.calls.length
      } finally {
        map.mockRestore()
      }
      expect(editor.state.doc.textContent).toBe(expected)
      expect(mappingCalls).toBeLessThan(lines * 8)
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.textContent).toBe(original)
      expect(editor.commands.redo()).toBe(true)
      expect(editor.state.doc.textContent).toBe(expected)
    } finally {
      editor.destroy()
    }
  }
)

it('preserves paragraph links and keeps later autolinking active after code indentation', () => {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'kept',
              marks: [{ type: 'link', attrs: { href: 'https://kept.test' } }]
            }
          ]
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'https://code.test\nnext' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'https://new.test' }] }
      ]
    }
  })
  try {
    const first = editor.state.doc.firstChild
    if (!first) {
      throw new Error('Missing paragraph')
    }
    const from = first.nodeSize + 1
    editor.commands.setTextSelection({ from, to: from + 'https://code.test\nnext'.length })
    expect(indentRichMarkdownCodeBlock(editor)).toBe(true)
    expect(editor.state.doc.firstChild?.eq(first)).toBe(true)
    const code = editor.state.doc.child(1)
    expect(code.textContent).toBe('  https://code.test\n  next')
    code.forEach((node) => expect(node.marks).toEqual([]))
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertContent(' ')
    const link = editor.state.doc.lastChild?.firstChild?.marks.find(
      (mark) => mark.type.name === 'link'
    )
    expect(link?.attrs.href).toBe('https://new.test')
  } finally {
    editor.destroy()
  }
})
