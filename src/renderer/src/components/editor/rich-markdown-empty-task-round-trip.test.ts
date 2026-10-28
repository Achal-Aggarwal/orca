// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { normalizeEmptyListItems } from './rich-markdown-normalize'
import { registerRichMarkdownBlockSource } from './rich-markdown-block-source'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

function openMarkdown(source: string, codec = createRichMarkdownEditorCodec()): Editor {
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  normalizeEmptyListItems(editor)
  registerRichMarkdownBlockSource(editor, codec, false)
  return editor
}

function roundTrip(source: string): string {
  const editor = openMarkdown(source)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

function tasks(editor: Editor) {
  const items: { text: string; checked: boolean; depth: number }[] = []
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'taskItem') {
      items.push({
        text: node.firstChild?.textContent ?? '',
        checked: node.attrs.checked === true,
        depth: editor.state.doc.resolve(position).depth
      })
    }
  })
  return items
}

const parents = [
  ['4. Parent', '   ', 3],
  ['- Parent', '  ', 3],
  ['4. Parent\n   1. Nested', '      ', 5]
] as const

const cases = parents.flatMap(([parent, indent, depth]) =>
  ['\n', '\r\n'].map((newline) => ({
    source: `${parent}\n${indent}- [ ] First\n${indent}- [x] Done`.replaceAll('\n', newline),
    depth
  }))
)

describe('empty nested task save/reopen', () => {
  it('parses each nested parent once when the final task is empty', () => {
    const depth = 8
    const source = Array.from({ length: depth }, (_, index) => `${'  '.repeat(index)}- Parent`)
      .concat(`${'  '.repeat(depth)}- [ ] `)
      .join('\n')
    const codec = createRichMarkdownEditorCodec()
    const editor = openMarkdown('', codec)
    const blockTokens = vi.spyOn(codec.marked.Lexer.prototype, 'blockTokens')
    try {
      const document = editor.schema.nodeFromJSON(editor.markdown!.parse(source))
      document.check()
      let emptyTasks = 0
      document.descendants((node) => {
        if (node.type.name === 'taskItem' && node.textContent === '') {
          emptyTasks += 1
        }
      })
      expect(emptyTasks).toBe(1)
      expect(blockTokens).toHaveBeenCalledTimes(depth + 2)
    } finally {
      blockTokens.mockRestore()
      editor.destroy()
    }
  })

  it.each(cases)('keeps the checkbox created by Enter in $source', ({ source, depth }) => {
    const editor = openMarkdown(source)
    try {
      const refs = {
        originalSourceRef: { current: source },
        baseCanonicalRef: { current: editor.getMarkdown() },
        lastCommittedMarkdownRef: { current: source }
      }
      let end = -1
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === 'taskItem' && node.firstChild?.textContent === 'Done') {
          end = position + 2 + node.firstChild.content.size
        }
      })
      expect(end).toBeGreaterThan(0)
      editor.commands.setTextSelection(end)
      expect(editor.commands.splitListItem('taskItem')).toBe(true)
      const expected = [
        { text: 'First', checked: false, depth },
        { text: 'Done', checked: true, depth },
        { text: '', checked: false, depth }
      ]
      expect(tasks(editor)).toEqual(expected)
      const saved = commitRichMarkdownSerialization(editor, refs, roundTrip)
      expect(saved.didSerialize).toBe(true)
      const reopened = openMarkdown(saved.markdown)
      try {
        reopened.state.doc.check()
        expect(tasks(reopened)).toEqual(expected)
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })

  it.each([
    '- Parent\n  - [ ]',
    '4. Parent\n   - [ ]',
    '- Parent\n  - [x]',
    '- Parent\n  - [x]word ',
    '- Parent\n  - [z] ',
    '- Parent\n  - \\[ ] ',
    '- Parent\n  ```md\n  - [ ] \n  ```',
    '- Parent\n\n      - [ ] '
  ])('preserves literal markers and code in %s', (source) => {
    const editor = openMarkdown(source)
    try {
      editor.state.doc.check()
      expect(tasks(editor)).toEqual([])
    } finally {
      editor.destroy()
    }
  })
})
