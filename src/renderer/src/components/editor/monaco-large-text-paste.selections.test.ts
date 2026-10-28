// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { editor as monacoEditor, Selection } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { executeMonacoLargeTextPaste, type MonacoPasteEditor } from './monaco-large-text-paste'

const models: monacoEditor.ITextModel[] = []

function makeEditor(value: string, initialSelections: Selection[]) {
  const model = monacoEditor.createModel(value, 'plaintext')
  models.push(model)
  const container = document.createElement('div')
  document.body.appendChild(container)
  let selections = initialSelections
  const batchCodeUnits: number[] = []
  const editor: MonacoPasteEditor = {
    getModel: () => model,
    getContainerDomNode: () => container,
    hasTextFocus: () => true,
    getSelections: () => selections,
    executeEdits: (_source, edits, cursorState) => {
      batchCodeUnits.push(edits.reduce((sum, edit) => sum + (edit.text?.length ?? 0), 0))
      const result = model.pushEditOperations(selections, edits, (inverse) =>
        typeof cursorState === 'function' ? cursorState(inverse) : (cursorState ?? null)
      )
      if (result) {
        selections = result
      }
      return true
    },
    pushUndoStop: () => {
      model.pushStackElement()
      return true
    }
  }
  return { editor, model, batchCodeUnits }
}

afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
  document.body.replaceChildren()
})

describe('chunked Monaco paste selections', () => {
  it('replaces every range across chunks, preserves the primary cursor and groups undo/redo', async () => {
    const initial = 'first\nkeep\nsecond\n'
    const { editor, model } = makeEditor(initial, [
      new Selection(3, 7, 3, 1),
      new Selection(1, 1, 1, 6)
    ])
    const text = 'ab\n😀cd'
    const result = await executeMonacoLargeTextPaste(editor, text, {
      chunkMaxBytes: 5,
      yieldToEventLoop: async () => {}
    })

    expect(result.status).toBe('pasted')
    expect(model.getValue()).toBe(`${text}\nkeep\n${text}\n`)
    expect(
      editor
        .getSelections()
        ?.map((selection) => [selection.positionLineNumber, selection.positionColumn])
    ).toEqual([
      [5, 5],
      [2, 5]
    ])
    await model.undo()
    expect(model.getValue()).toBe(initial)
    await model.redo()
    expect(model.getValue()).toBe(`${text}\nkeep\n${text}\n`)
  })

  it('keeps adjacent ranges distinct when the primary selection comes last in the document', async () => {
    const { editor, model } = makeEditor('abcd', [
      new Selection(1, 3, 1, 5),
      new Selection(1, 1, 1, 3)
    ])
    await executeMonacoLargeTextPaste(editor, 'XYZ', {
      chunkMaxBytes: 2,
      yieldToEventLoop: async () => {}
    })

    expect(model.getValue()).toBe('XYZXYZ')
    expect(editor.getSelections()?.map((selection) => selection.positionColumn)).toEqual([7, 4])
  })

  it('computes all cursors using the model newline convention', async () => {
    const { editor, model } = makeEditor('one\r\ntwo\r\n', [
      new Selection(1, 1, 1, 4),
      new Selection(2, 1, 2, 4)
    ])
    await executeMonacoLargeTextPaste(editor, 'a\nb\rc\r\nd', { chunkMaxBytes: 64 })

    expect(model.getValue()).toBe('a\r\nb\r\nc\r\nd\r\na\r\nb\r\nc\r\nd\r\n')
    expect(
      editor
        .getSelections()
        ?.map((selection) => [selection.positionLineNumber, selection.positionColumn])
    ).toEqual([
      [4, 2],
      [8, 2]
    ])
  })

  it('shares each turn byte budget across selections while delivering the complete paste', async () => {
    const { editor, model, batchCodeUnits } = makeEditor('x\nx', [
      new Selection(1, 1, 1, 2),
      new Selection(2, 1, 2, 2)
    ])
    await executeMonacoLargeTextPaste(editor, 'abcdefgh', {
      chunkMaxBytes: 4,
      yieldToEventLoop: async () => {}
    })

    expect(model.getValue()).toBe('abcdefgh\nabcdefgh')
    expect(batchCodeUnits).toEqual([4, 4, 4, 4])
  })

  it('retains every cursor when Monaco coalesces a large operation list', async () => {
    const count = 1001
    const { editor, model } = makeEditor(
      'x\n'.repeat(count),
      Array.from({ length: count }, (_, index) => new Selection(index + 1, 1, index + 1, 2))
    )
    await executeMonacoLargeTextPaste(editor, 'AB', {
      chunkMaxBytes: 1,
      yieldToEventLoop: async () => {}
    })

    expect(model.getValue()).toBe('AB\n'.repeat(count))
    expect(editor.getSelections()).toHaveLength(count)
    expect(editor.getSelections()?.at(-1)?.positionColumn).toBe(3)
  })
})
