// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { TableMap } from '@tiptap/pm/tables'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { runRichMarkdownTableAction } from './rich-markdown-table-actions'

function createEditor(rows: number): Editor {
  const content = [
    '| A | B | C | D |',
    '| --- | --- | --- | --- |',
    ...Array.from({ length: rows - 1 }, (_, row) => `| ${row}:0 | ${row}:1 | ${row}:2 | ${row}:3 |`)
  ].join('\n')
  return new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
}

function cellAtText(editor: Editor, text: string): number {
  let position: number | undefined
  editor.state.doc.descendants((node, pos) => {
    const role = node.type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') {
      if (node.textContent === text) {
        position = pos
      }
      return false
    }
    return true
  })
  if (position === undefined) {
    throw new Error(`Expected cell text: ${text}`)
  }
  return position
}

describe.each([10, 100])('rich markdown table coverage with %s rows', (rows) => {
  it.each([
    'insert-row-below',
    'insert-column-left',
    'insert-column-right',
    'delete-table'
  ] as const)('skips unused coverage for %s', (action) => {
    const editor = createEditor(rows)
    const target = cellAtText(editor, `${rows - 2}:1`)
    editor.commands.setTextSelection(target + 2)
    const table = editor.state.doc.firstChild
    if (!table) {
      throw new Error('Expected a table')
    }
    const scan = vi.spyOn(TableMap.get(table).map, 'forEach')
    try {
      expect(runRichMarkdownTableAction(editor, action, { cellPosition: target })).toBe(true)

      expect(scan).not.toHaveBeenCalled()
    } finally {
      scan.mockRestore()
      editor.destroy()
    }
  })
})

describe('rich markdown table required coverage', () => {
  it.each([
    ['insert-row-above', 'A', false],
    ['delete-row', '8:1', true],
    ['delete-column', '8:1', true]
  ] as const)('retains coverage for %s', (action, targetText, expectedSuccess) => {
    const editor = createEditor(10)
    const target = cellAtText(editor, targetText)
    editor.commands.setTextSelection(target + 2)
    const table = editor.state.doc.firstChild
    if (!table) {
      throw new Error('Expected a table')
    }
    const scan = vi.spyOn(TableMap.get(table).map, 'forEach')
    try {
      expect(runRichMarkdownTableAction(editor, action, { cellPosition: target })).toBe(
        expectedSuccess
      )

      expect(scan).toHaveBeenCalledTimes(1)
    } finally {
      scan.mockRestore()
      editor.destroy()
    }
  })
})
