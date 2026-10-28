// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { editor as monacoEditor, Selection } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { executeMonacoLargeTextPaste, type MonacoPasteEditor } from './monaco-large-text-paste'
import { runOrcaContextMenuPaste } from './monaco-context-menu-paste'

const models: monacoEditor.ITextModel[] = []

function makeEditor(value: string, initialSelections: Selection[]) {
  const model = monacoEditor.createModel(value, 'plaintext')
  models.push(model)
  const container = document.createElement('div')
  document.body.appendChild(container)
  let selections = initialSelections
  const batchSizes: number[] = []
  const editor: MonacoPasteEditor = {
    getModel: () => model,
    getContainerDomNode: () => container,
    hasTextFocus: () => true,
    getSelections: () => selections,
    executeEdits: (_source, edits, cursorState) => {
      batchSizes.push(edits.reduce((total, edit) => total + (edit.text?.length ?? 0), 0))
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
  return { editor, model, batchSizes }
}

afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
  document.body.replaceChildren()
})

describe('large paste clipboard metadata', () => {
  it('distributes unequal copied parts in document order, preserving primary order and undo', async () => {
    const initial = 'first\nsecond'
    const { editor, model, batchSizes } = makeEditor(initial, [
      new Selection(2, 7, 2, 1),
      new Selection(1, 1, 1, 6)
    ])
    await executeMonacoLargeTextPaste(editor, 'A\nLONGER\nPART', {
      multicursorText: ['A', 'LONGER\nPART'],
      chunkMaxBytes: 4,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('A\nLONGER\nPART')
    expect(
      editor
        .getSelections()
        ?.map((selection) => [selection.positionLineNumber, selection.positionColumn])
    ).toEqual([
      [3, 5],
      [1, 2]
    ])
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(4)
    await model.undo()
    expect(model.getValue()).toBe(initial)
    await model.redo()
    expect(model.getValue()).toBe('A\nLONGER\nPART')
  })

  it('replaces an empty copied part without losing the remaining destination', async () => {
    const { editor, model } = makeEditor('first\nsecond', [
      new Selection(1, 1, 1, 6),
      new Selection(2, 1, 2, 7)
    ])
    await executeMonacoLargeTextPaste(editor, '\nXYZ', {
      multicursorText: ['', 'XYZ'],
      chunkMaxBytes: 1,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('\nXYZ')
    expect(
      editor
        .getSelections()
        ?.map((selection) => [selection.positionLineNumber, selection.positionColumn])
    ).toEqual([
      [1, 1],
      [2, 4]
    ])
  })

  it('keeps CRLF and emoji intact in independently advancing copied parts', async () => {
    const { editor, model } = makeEditor('a\r\nb', [
      new Selection(1, 1, 1, 2),
      new Selection(2, 1, 2, 2)
    ])
    await executeMonacoLargeTextPaste(editor, '😀\r\nx\r\ny', {
      multicursorText: ['😀\r\nx', 'y'],
      chunkMaxBytes: 1,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('😀\r\nx\r\ny')
  })

  it('inserts a copied whole line before an empty cursor and preserves its column', async () => {
    const initial = 'target\r\n'
    const { editor, model } = makeEditor(initial, [new Selection(1, 4, 1, 4)])
    await executeMonacoLargeTextPaste(editor, 'COPIED\n', {
      pasteOnNewLine: true,
      chunkMaxBytes: 2,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('COPIED\r\ntarget\r\n')
    expect(
      editor
        .getSelections()
        ?.map((selection) => [selection.positionLineNumber, selection.positionColumn])
    ).toEqual([[2, 4]])
    await model.undo()
    expect(model.getValue()).toBe(initial)
  })

  it('keeps ordinary replacement for a nonempty range and mismatched multicursor metadata', async () => {
    const { editor, model } = makeEditor('first\nsecond', [
      new Selection(1, 1, 1, 6),
      new Selection(2, 1, 2, 7)
    ])
    await executeMonacoLargeTextPaste(editor, 'X\n', {
      pasteOnNewLine: true,
      multicursorText: ['only-one'],
      chunkMaxBytes: 2,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('X\n\nX\n')
  })

  it('passes native copy metadata through the actual large context-menu route', async () => {
    const { editor, model } = makeEditor('first\nsecond', [
      new Selection(1, 1, 1, 6),
      new Selection(2, 1, 2, 7)
    ])
    const alpha = 'a'.repeat(34000)
    const beta = 'b'.repeat(35000)
    const trigger = vi.fn()
    const outcome = await runOrcaContextMenuPaste({
      getFocusedEditor: () => ({ ...editor, getOption: vi.fn().mockReturnValue(false), trigger }),
      readClipboardText: async () => `${alpha}\n${beta}`,
      getClipboardMetadata: () => ({ multicursorText: [alpha, beta] }),
      emptySelectionClipboardOptionId: monacoEditor.EditorOption.emptySelectionClipboard,
      readOnlyOptionId: monacoEditor.EditorOption.readOnly
    })
    expect(outcome).toEqual({ status: 'pasted', mode: 'chunked' })
    expect(model.getValue() === `${alpha}\n${beta}`).toBe(true)
    expect(trigger).not.toHaveBeenCalled()
  })
  it('spreads external lines only when the option and exact line count permit it', async () => {
    const { editor, model } = makeEditor('first\nsecond', [
      new Selection(1, 1, 1, 6),
      new Selection(2, 1, 2, 7)
    ])
    await executeMonacoLargeTextPaste(editor, 'A\r\nB\r\n', {
      multiCursorPaste: 'spread',
      chunkMaxBytes: 1,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('A\nB')
    const fallback = makeEditor('first\nsecond', [
      new Selection(1, 1, 1, 6),
      new Selection(2, 1, 2, 7)
    ])
    await executeMonacoLargeTextPaste(fallback.editor, 'A\nB\nC', {
      multiCursorPaste: 'spread',
      chunkMaxBytes: 2,
      yieldToEventLoop: async () => {}
    })
    expect(fallback.model.getValue()).toBe('A\nB\nC\nA\nB\nC')
  })

  it('passes the actual context-menu multicursor policy without native copy metadata', async () => {
    const { editor, model } = makeEditor('first\nsecond', [
      new Selection(1, 1, 1, 6),
      new Selection(2, 1, 2, 7)
    ])
    const alpha = 'a'.repeat(34000)
    const beta = 'b'.repeat(35000)
    await runOrcaContextMenuPaste({
      getFocusedEditor: () => ({
        ...editor,
        getOption: vi
          .fn()
          .mockImplementation((id) =>
            id === monacoEditor.EditorOption.multiCursorPaste ? 'spread' : false
          ),
        trigger: vi.fn()
      }),
      readClipboardText: async () => `${alpha}\n${beta}`,
      getClipboardMetadata: () => null,
      emptySelectionClipboardOptionId: monacoEditor.EditorOption.emptySelectionClipboard,
      readOnlyOptionId: monacoEditor.EditorOption.readOnly,
      multiCursorPasteOptionId: monacoEditor.EditorOption.multiCursorPaste
    })
    expect(model.getValue() === `${alpha}\n${beta}`).toBe(true)
  })
})
