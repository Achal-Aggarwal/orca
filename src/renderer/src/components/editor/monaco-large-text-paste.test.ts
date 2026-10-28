// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { editor as monacoEditor, Selection } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { handleMonacoLargeTextPaste } from './monaco-large-text-paste'

const models: monacoEditor.ITextModel[] = []

function pasteEvent(text: string): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/plain' ? text : '')
    }
  })
  return event
}

function makeEditor() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const model = monacoEditor.createModel('', 'plaintext')
  models.push(model)
  let currentModel = model
  let focused = true
  let selections = [new Selection(1, 1, 1, 1)]
  const edits: string[] = []
  const undoStops: number[] = []
  const editor = {
    getModel: () => currentModel,
    getContainerDomNode: () => container,
    hasTextFocus: () => focused,
    getSelection: () => selections[0],
    getSelections: () => selections,
    executeEdits: (
      _source: string,
      nextEdits: monacoEditor.IIdentifiedSingleEditOperation[],
      cursorState?: monacoEditor.ICursorStateComputer | Selection[]
    ) => {
      edits.push(...nextEdits.map((edit) => edit.text ?? ''))
      const result = currentModel.pushEditOperations(selections, nextEdits, (inverse) =>
        typeof cursorState === 'function' ? cursorState(inverse) : (cursorState ?? null)
      )
      if (result) {
        selections = result
      }
      return true
    },
    pushUndoStop: () => {
      undoStops.push(1)
      return true
    },
    getValue: () => currentModel.getValue()
  }
  return {
    container,
    editor,
    edits,
    undoStops,
    setFocused: (next: boolean) => {
      focused = next
    },
    replaceModel: () => {
      currentModel = monacoEditor.createModel('', 'plaintext')
      models.push(currentModel)
    }
  }
}

async function flushPromises(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('monaco large text paste', () => {
  it('leaves small, read-only, and already-owned paste to existing Monaco behavior', () => {
    const { editor } = makeEditor()
    const smallPaste = pasteEvent('small')
    const readOnlyPaste = pasteEvent('x'.repeat(128))
    const handledPaste = pasteEvent('x'.repeat(128))
    handledPaste.preventDefault()

    expect(handleMonacoLargeTextPaste(editor as never, smallPaste, { directMaxBytes: 64 })).toEqual(
      { status: 'ignored', reason: 'small' }
    )
    expect(
      handleMonacoLargeTextPaste(editor as never, readOnlyPaste, {
        readOnly: true,
        directMaxBytes: 8
      })
    ).toEqual({ status: 'ignored', reason: 'read-only' })
    expect(handleMonacoLargeTextPaste(editor as never, handledPaste)).toEqual({
      status: 'ignored',
      reason: 'already-handled'
    })
    expect(smallPaste.defaultPrevented).toBe(false)
  })

  it('chunks large Monaco paste edits and reports one completed owner result', async () => {
    const { editor, edits, undoStops } = makeEditor()
    const resultSpy = vi.fn()
    const startSpy = vi.fn()
    const yieldToEventLoop = vi.fn(async () => {})
    const event = pasteEvent('abcdef'.repeat(4))

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop,
      onPasteStart: startSpy,
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(result).toEqual({ status: 'handled' })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual(['abcdef', 'abcdef', 'abcdef', 'abcdef'])
    expect(yieldToEventLoop).toHaveBeenCalledTimes(3)
    expect(undoStops).toHaveLength(2)
    expect(startSpy).toHaveBeenCalledOnce()
    expect(resultSpy).toHaveBeenCalledWith({
      status: 'pasted',
      mode: 'chunked',
      byteLength: 24,
      chunksWritten: 4
    })
  })

  it('still reports a result when the chunked paste throws, so its start state releases', async () => {
    const { editor } = makeEditor()
    const resultSpy = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paste reads only the editor methods makeEditor stubs.
    handleMonacoLargeTextPaste(editor as never, pasteEvent('abcdef'.repeat(4)), {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop: async () => {
        throw new Error('yield failed')
      },
      onPasteStart: vi.fn(),
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(resultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', reason: 'target-unavailable' })
    )
  })

  it('claims large Monaco paste with bounded ownership measuring before yielded insertion', async () => {
    const { editor, edits } = makeEditor()
    const resultSpy = vi.fn()
    const yieldToEventLoop = vi.fn(async () => {})
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')
    const text = 'x'.repeat(32)
    const event = pasteEvent(text)

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 4,
      chunkMaxBytes: 64,
      maxBytes: 64,
      measureYieldAfterCodeUnits: 8,
      yieldToEventLoop,
      onPasteResult: resultSpy
    })

    expect(result).toEqual({ status: 'handled' })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual([])
    expect(codePointAt.mock.calls.length).toBeLessThan(text.length)

    await flushPromises()

    expect(edits.join('')).toBe(text)
    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(resultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pasted', mode: 'chunked' })
    )
  })

  it('updates Monaco selection for mixed newlines', async () => {
    const { editor, edits } = makeEditor()
    const text = 'a\r\nbb\nc\rd'
    const event = pasteEvent(text)

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 1,
      chunkMaxBytes: 64
    })
    await flushPromises()

    expect(result).toEqual({ status: 'handled' })
    expect(edits).toEqual([text])
    expect(editor.getSelection()).toMatchObject({
      endColumn: 2,
      endLineNumber: 4,
      startColumn: 2,
      startLineNumber: 4
    })
  })

  it('cancels chunking when focus leaves the original Monaco target', async () => {
    const { editor, edits, setFocused } = makeEditor()
    const resultSpy = vi.fn()
    const event = pasteEvent('abcdef'.repeat(4))

    handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop: async () => {
        setFocused(false)
      },
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(edits).toEqual(['abcdef'])
    expect(resultSpy).toHaveBeenCalledWith({
      status: 'cancelled',
      reason: 'target-unavailable',
      byteLength: 24,
      chunksWritten: 1
    })
  })

  it('cancels chunking when Monaco switches models during paste', async () => {
    const { editor, edits, replaceModel } = makeEditor()
    const resultSpy = vi.fn()
    const event = pasteEvent('abcdef'.repeat(4))

    handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop: async () => {
        replaceModel()
      },
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(edits).toEqual(['abcdef'])
    expect(resultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', reason: 'target-unavailable' })
    )
  })

  it('rejects oversized Monaco paste without inserting clipboard content', async () => {
    const { editor, edits } = makeEditor()
    const resultSpy = vi.fn()
    const secret = 'secret-token-value'
    const event = pasteEvent(secret)

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 4,
      maxBytes: 8,
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(result).toEqual({ status: 'handled' })
    expect(resultSpy).toHaveBeenCalledWith({
      status: 'rejected',
      reason: 'too-large',
      byteLength: 9,
      chunksWritten: 0
    })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual([])
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(resultSpy.mock.calls)).not.toContain(secret)
  })

  it('rejects multibyte oversized Monaco paste with bounded byte measurement', async () => {
    const { editor, edits } = makeEditor()
    const resultSpy = vi.fn()
    const event = pasteEvent('😀'.repeat(100))

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 4,
      maxBytes: 5,
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(result).toEqual({ status: 'handled' })
    expect(resultSpy).toHaveBeenCalledWith({
      status: 'rejected',
      reason: 'too-large',
      byteLength: 8,
      chunksWritten: 0
    })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual([])
  })

  it('rejects oversized Monaco paste even when the direct threshold is larger', () => {
    const { editor, edits } = makeEditor()
    const event = pasteEvent('abcdef')

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 64,
      maxBytes: 5
    })

    expect(result).toEqual({
      status: 'rejected',
      reason: 'too-large',
      byteLength: 6,
      chunksWritten: 0
    })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual([])
  })
})
