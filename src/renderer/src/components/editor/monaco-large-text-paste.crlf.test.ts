// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { editor as monacoEditor, Selection } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { executeMonacoLargeTextPaste, type MonacoPasteEditor } from './monaco-large-text-paste'

const models: monacoEditor.ITextModel[] = []

function makeEditor(crlf = false) {
  const model = monacoEditor.createModel('', 'plaintext')
  if (crlf) {
    model.setEOL(monacoEditor.EndOfLineSequence.CRLF)
  }
  models.push(model)
  const container = document.createElement('div')
  document.body.appendChild(container)
  let selection = new Selection(1, 1, 1, 1)
  const editor: MonacoPasteEditor &
    Pick<monacoEditor.ICodeEditor, 'getSelection' | 'getSelections' | 'setSelection'> = {
    getModel: () => model,
    getContainerDomNode: () => container,
    hasTextFocus: () => true,
    getSelection: () => selection,
    getSelections: () => [selection],
    setSelection: (range) => {
      selection =
        'selectionStartLineNumber' in range
          ? new Selection(
              range.selectionStartLineNumber,
              range.selectionStartColumn,
              range.positionLineNumber,
              range.positionColumn
            )
          : new Selection(
              range.startLineNumber,
              range.startColumn,
              range.endLineNumber,
              range.endColumn
            )
    },
    executeEdits: (_source, edits, cursorState) => {
      const result = model.pushEditOperations([selection], edits, (inverse) =>
        typeof cursorState === 'function' ? cursorState(inverse) : (cursorState ?? null)
      )
      if (result?.[0]) {
        selection = result[0]
      }
      return true
    },
    pushUndoStop: () => {
      model.pushStackElement()
      return true
    }
  }
  return { editor, model }
}

afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
  document.body.replaceChildren()
})

describe('chunked Monaco paste CRLF boundaries', () => {
  it.each([1, 2, 4, 5])('keeps one newline with a %i-byte chunk budget', async (chunkMaxBytes) => {
    const { editor, model } = makeEditor()
    await executeMonacoLargeTextPaste(editor, 'aaa\r\nb', {
      chunkMaxBytes,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('aaa\nb')
  })

  it('keeps CRLF models and the complete paste in one undo group', async () => {
    const { editor, model } = makeEditor(true)
    await executeMonacoLargeTextPaste(editor, 'aaa\r\nb', {
      chunkMaxBytes: 4,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('aaa\r\nb')
    await model.undo()
    expect(model.getValue()).toBe('')
    await model.redo()
    expect(model.getValue()).toBe('aaa\r\nb')
  })

  it('keeps repeated CRLF and surrogate pairs intact at a minimum chunk budget', async () => {
    const { editor, model } = makeEditor()
    await executeMonacoLargeTextPaste(editor, '😀\r\nx\r\n\r\ny', {
      chunkMaxBytes: 1,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('😀\nx\n\ny')
  })
})
