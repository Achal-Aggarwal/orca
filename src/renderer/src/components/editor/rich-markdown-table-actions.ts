import type { Editor } from '@tiptap/react'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { CellSelection, selectedRect, selectionCell, TableMap } from '@tiptap/pm/tables'

export type RichMarkdownTableAction =
  | 'insert-row-above'
  | 'insert-row-below'
  | 'delete-row'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'delete-column'
  | 'delete-table'

export type RichMarkdownTableActionTarget =
  | { cellPosition: number }
  | { clientX: number; clientY: number }

type TableContext = {
  columnCount: number
  hasHeaderRow: boolean
  rowCount: number
  tablePosition: number
}

function cellPositionAtDocumentPosition(editor: Editor, position: number): number | null {
  // Cached positions can outlive a document shrink; resolve would throw beyond its new end.
  if (position < 0 || position > editor.state.doc.content.size) {
    return null
  }
  const $position = editor.state.doc.resolve(position)
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const role = $position.node(depth).type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') {
      return $position.before(depth)
    }
  }
  return null
}

export function richMarkdownTableCellPositionAtElement(
  editor: Editor,
  cell: HTMLTableCellElement
): number | null {
  try {
    return cellPositionAtDocumentPosition(editor, editor.view.posAtDOM(cell, 0))
  } catch {
    return null
  }
}

function cellPositionAtTarget(
  editor: Editor,
  target: RichMarkdownTableActionTarget
): number | null {
  if ('cellPosition' in target) {
    return cellPositionAtDocumentPosition(editor, target.cellPosition + 1)
  }
  try {
    const position = editor.view.posAtCoords({ left: target.clientX, top: target.clientY })?.pos
    return position === undefined ? null : cellPositionAtDocumentPosition(editor, position)
  } catch {
    return null
  }
}

function normalizeMultiCellSelection(editor: Editor): CellSelection | null {
  const { selection } = editor.state
  if (selection instanceof CellSelection) {
    return selection
  }
  if (selection.empty) {
    return null
  }
  const anchor = cellPositionAtDocumentPosition(editor, selection.from)
  const head = cellPositionAtDocumentPosition(editor, selection.to)
  if (anchor === null || head === null || anchor === head) {
    return null
  }
  try {
    return CellSelection.create(editor.state.doc, anchor, head)
  } catch {
    return null
  }
}

function retargetTableSelection(
  editor: Editor,
  target: RichMarkdownTableActionTarget | undefined
): number | null {
  const existingMultiCellSelection = normalizeMultiCellSelection(editor)
  if (existingMultiCellSelection && !(editor.state.selection instanceof CellSelection)) {
    editor.view.dispatch(editor.state.tr.setSelection(existingMultiCellSelection))
  }
  if (!target) {
    return editor.isActive('table') ? selectionCell(editor.state).pos : null
  }

  const cellPosition = cellPositionAtTarget(editor, target)
  if (cellPosition === null) {
    return null
  }
  const selection = editor.state.selection
  let selectedTarget = false
  if (selection instanceof CellSelection) {
    selection.forEachCell((_cell, position) => {
      selectedTarget ||= position === cellPosition
    })
  }
  if (!selectedTarget) {
    const caret = TextSelection.near(editor.state.doc.resolve(cellPosition + 1))
    editor.view.dispatch(editor.state.tr.setSelection(caret))
  }
  return cellPosition
}

function tableContext(editor: Editor, targetCellPosition: number): TableContext | null {
  const $cell = editor.state.doc.resolve(targetCellPosition)
  if (
    $cell.nodeAfter?.type.spec.tableRole !== 'cell' &&
    $cell.nodeAfter?.type.spec.tableRole !== 'header_cell'
  ) {
    return null
  }
  let table: ReturnType<typeof $cell.node> | null = null
  let tablePosition = 0
  for (let depth = $cell.depth; depth > 0; depth -= 1) {
    const node = $cell.node(depth)
    if (node.type.spec.tableRole === 'table') {
      table = node
      tablePosition = $cell.before(depth)
      break
    }
  }
  if (!table) {
    return null
  }
  const tableMap = TableMap.get(table)
  return {
    columnCount: tableMap.width,
    hasHeaderRow: table.firstChild?.firstChild?.type.spec.tableRole === 'header_cell',
    rowCount: tableMap.height,
    tablePosition
  }
}

function selectedTableCoverage(
  editor: Editor,
  context: TableContext,
  targetCellPosition: number
): {
  columns: Set<number>
  rows: Set<number>
  includesHeader: boolean
} {
  const table = editor.state.doc.nodeAt(context.tablePosition)
  const columns = new Set<number>()
  const rows = new Set<number>()
  let includesHeader = false
  if (!table) {
    return { columns, rows, includesHeader }
  }
  const selectedCellPositions = new Set<number>()
  const selection = editor.state.selection
  if (selection instanceof CellSelection) {
    selection.forEachCell((_cell, position) => selectedCellPositions.add(position))
  } else {
    selectedCellPositions.add(targetCellPosition)
  }
  const tableMap = TableMap.get(table)
  const tableStart = context.tablePosition + 1
  tableMap.map.forEach((cellOffset, index) => {
    const position = tableStart + cellOffset
    if (!selectedCellPositions.has(position)) {
      return
    }
    rows.add(Math.floor(index / tableMap.width))
    columns.add(index % tableMap.width)
    includesHeader ||= editor.state.doc.nodeAt(position)?.type.spec.tableRole === 'header_cell'
  })
  return { columns, rows, includesHeader }
}

// Rebalance on the insertion transaction so both changes share one undo step.
function rebalanceAddedColumn(
  transaction: Transaction,
  tablePosition: number,
  insertedColumnIndex: number
): void {
  const table = transaction.doc.nodeAt(tablePosition)
  const row = table?.firstChild
  if (!table || !row) {
    return
  }
  const cells: { width: number | null }[] = []
  let hasSpans = false
  let hasRowspans = false
  row.forEach((cell, _offset, index) => {
    if (cell.attrs.colspan && cell.attrs.colspan !== 1) {
      hasSpans = true
      return
    }
    const width = index === insertedColumnIndex ? null : cell.attrs.colwidth?.[0]
    cells.push({ width: typeof width === 'number' ? width : null })
  })
  table.forEach((tableRow) => {
    tableRow.forEach((cell) => {
      hasSpans ||= Boolean(cell.attrs.colspan && cell.attrs.colspan !== 1)
      hasRowspans ||= Boolean(cell.attrs.rowspan && cell.attrs.rowspan !== 1)
    })
  })
  const newColumns = cells.filter((cell) => cell.width === null)
  const existingWidth = cells.reduce((total, cell) => total + (cell.width ?? 0), 0)
  if (hasSpans || cells.length === 0 || newColumns.length === 0 || existingWidth <= 0) {
    return
  }
  const newWidth = existingWidth / cells.length
  const existingScale = (existingWidth - newWidth * newColumns.length) / existingWidth
  const widths = cells.map((cell) => {
    const width = cell.width === null ? newWidth : cell.width * existingScale
    return Math.max(1, Math.round(width))
  })
  const tableMap = hasRowspans ? TableMap.get(table) : null
  table.forEach((tableRow, rowOffset, rowIndex) => {
    let columnIndex = 0
    tableRow.forEach((cell, cellOffset) => {
      if (tableMap) {
        const cellPosition = rowOffset + cellOffset + 1
        while (
          columnIndex < tableMap.width &&
          tableMap.map[rowIndex * tableMap.width + columnIndex] !== cellPosition
        ) {
          columnIndex += 1
        }
        if (columnIndex === tableMap.width) {
          return
        }
      }
      transaction.setNodeMarkup(tablePosition + 2 + rowOffset + cellOffset, undefined, {
        ...cell.attrs,
        colwidth: [widths[columnIndex]]
      })
      columnIndex += 1
    })
  })
}

export function runRichMarkdownTableAction(
  editor: Editor,
  action: RichMarkdownTableAction,
  target?: RichMarkdownTableActionTarget
): boolean {
  if (!editor.isEditable) {
    return false
  }
  const targetCellPosition = retargetTableSelection(editor, target)
  if (targetCellPosition === null) {
    return false
  }
  const context = tableContext(editor, targetCellPosition)
  if (!context) {
    return false
  }
  const chain = editor.chain().focus()

  switch (action) {
    case 'insert-row-above':
      if (
        context.hasHeaderRow &&
        selectedTableCoverage(editor, context, targetCellPosition).includesHeader
      ) {
        return false
      }
      return chain.addRowBefore().run()
    case 'insert-row-below':
      return chain.addRowAfter().run()
    case 'delete-row': {
      const coverage = selectedTableCoverage(editor, context, targetCellPosition)
      if (coverage.rows.size >= context.rowCount) {
        return chain.deleteTable().run()
      }
      if (context.hasHeaderRow && coverage.includesHeader) {
        return false
      }
      return chain.deleteRow().run()
    }
    case 'insert-column-left': {
      const insertedColumnIndex = selectedRect(editor.state).left
      return chain
        .addColumnBefore()
        .command(({ tr }) => {
          rebalanceAddedColumn(tr, context.tablePosition, insertedColumnIndex)
          return true
        })
        .run()
    }
    case 'insert-column-right': {
      const insertedColumnIndex = selectedRect(editor.state).right
      return chain
        .addColumnAfter()
        .command(({ tr }) => {
          rebalanceAddedColumn(tr, context.tablePosition, insertedColumnIndex)
          return true
        })
        .run()
    }
    case 'delete-column': {
      const coverage = selectedTableCoverage(editor, context, targetCellPosition)
      if (coverage.columns.size >= context.columnCount) {
        return chain.deleteTable().run()
      }
      return chain.deleteColumn().run()
    }
    case 'delete-table':
      return chain.deleteTable().run()
  }
}
