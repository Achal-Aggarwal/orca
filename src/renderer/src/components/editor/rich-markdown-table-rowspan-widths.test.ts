// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { Transaction } from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { runRichMarkdownTableAction } from './rich-markdown-table-actions'

function createEditor(rows: number, spanStart: number, lockedWidths = true): Editor {
  const widths = [300, 100, 200]
  const content = `<table>${Array.from({ length: rows }, (_, row) => {
    const cells = widths.map((width, column) => {
      if (row > spanStart && column === 0) {
        return ''
      }
      const tag = row === 0 ? 'th' : 'td'
      const rowspan = row === spanStart && column === 0 ? ` rowspan="${rows - spanStart}"` : ''
      const colwidth = lockedWidths ? ` colwidth="${width}"` : ''
      return `<${tag}${rowspan}${colwidth}>${row}:${column}</${tag}>`
    })
    return `<tr>${cells.join('')}</tr>`
  }).join('')}</table>`
  return new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content
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

function firstRowColumnWidths(editor: Editor): number[] {
  const widths: number[] = []
  editor.state.doc.firstChild?.firstChild?.forEach((cell) => {
    widths.push(cell.attrs.colwidth?.[0] ?? 0)
  })
  return widths
}

describe('rich markdown table rowspan widths', () => {
  it.each([
    ['insert-column-left', [225, 150, 75, 150]],
    ['insert-column-right', [225, 75, 150, 150]]
  ] as const)('preserves logical column widths for %s below a header rowspan', (action, widths) => {
    const editor = createEditor(3, 0)
    try {
      expect(
        runRichMarkdownTableAction(editor, action, { cellPosition: cellAtText(editor, '2:1') })
      ).toBe(true)

      expect(firstRowColumnWidths(editor)).toEqual(widths)
      const table = editor.state.doc.firstChild
      if (!table) {
        throw new Error('Expected a table')
      }
      expect(TableMap.get(table).problems).toBeNull()
      expect(editor.commands.undo()).toBe(true)
      expect(firstRowColumnWidths(editor)).toEqual([300, 100, 200])
    } finally {
      editor.destroy()
    }
  })

  it.each([
    [10, 32],
    [100, 302]
  ])('updates each physical cell once in a %s-row table', (rows, expectedMarkupCalls) => {
    const editor = createEditor(rows, 1)
    const setNodeMarkup = vi.spyOn(Transaction.prototype, 'setNodeMarkup')
    try {
      expect(
        runRichMarkdownTableAction(editor, 'insert-column-right', {
          cellPosition: cellAtText(editor, `${rows - 1}:1`)
        })
      ).toBe(true)

      expect(setNodeMarkup).toHaveBeenCalledTimes(expectedMarkupCalls)
      expect(firstRowColumnWidths(editor)).toEqual([225, 75, 150, 150])
    } finally {
      setNodeMarkup.mockRestore()
      editor.destroy()
    }
  })

  it.each(['insert-column-left', 'insert-column-right'] as const)(
    'keeps widths unset for %s below a rowspan',
    (action) => {
      const editor = createEditor(3, 0, false)
      try {
        expect(
          runRichMarkdownTableAction(editor, action, { cellPosition: cellAtText(editor, '2:1') })
        ).toBe(true)

        expect(firstRowColumnWidths(editor)).toEqual([0, 0, 0, 0])
      } finally {
        editor.destroy()
      }
    }
  )
})
