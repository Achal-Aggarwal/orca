// @vitest-environment happy-dom
import type { editor } from 'monaco-editor'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMarkdownDocLinkDecorationController,
  getMarkdownDocLinkDecorationRanges,
  MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS
} from './monaco-markdown-doc-link-decorations'

describe('getMarkdownDocLinkDecorationRanges', () => {
  it('returns Monaco ranges for valid doc links', () => {
    expect(getMarkdownDocLinkDecorationRanges('link to [[other.md]]')).toEqual([
      {
        startLineNumber: 1,
        startColumn: 9,
        endLineNumber: 1,
        endColumn: 21
      }
    ])
  })

  it('returns ranges for aliased doc links', () => {
    expect(getMarkdownDocLinkDecorationRanges('[[doc|Label]]')).toEqual([
      {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 14
      }
    ])
  })

  it('ignores unsupported doc link syntax', () => {
    expect(getMarkdownDocLinkDecorationRanges('[[doc|]] [[bad [target]] [[]]')).toEqual([])
  })

  it('ignores doc links inside inline and fenced code', () => {
    expect(
      getMarkdownDocLinkDecorationRanges('`[[inline]]`\n\n```md\n[[fenced]]\n```\n[[real]]')
    ).toEqual([
      {
        startLineNumber: 6,
        startColumn: 1,
        endLineNumber: 6,
        endColumn: 9
      }
    ])
  })

  it('supports CRLF markdown without splitting the full document', () => {
    const split = vi.spyOn(String.prototype, 'split')

    expect(getMarkdownDocLinkDecorationRanges('intro\r\n[[other.md]]\r\n')).toEqual([
      {
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 13
      }
    ])
    expect(split).not.toHaveBeenCalled()
  })

  it('scans pasted markdown without allocating one array entry per line', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const content = [
      '# Notes',
      ...Array.from({ length: 10_000 }, () => 'plain'),
      '[[target.md]]'
    ].join('\n')

    const ranges = getMarkdownDocLinkDecorationRanges(content)

    expect(ranges).toEqual([
      {
        startLineNumber: 10_002,
        startColumn: 1,
        endLineNumber: 10_002,
        endColumn: 14
      }
    ])
    expect(split).not.toHaveBeenCalled()
  })
})

function mountController(value: string, paneCount = 1) {
  const model = monaco.editor.createModel(value, 'markdown')
  const getValue = vi.spyOn(model, 'getValue')
  const getLineContent = vi.spyOn(model, 'getLineContent')
  let language = 'markdown'
  const panes = Array.from({ length: paneCount }, () => {
    let decorationIds: string[] = []
    const set = vi.fn((decorations: editor.IModelDeltaDecoration[]) => {
      decorationIds = model.deltaDecorations(decorationIds, decorations)
    })
    const clear = vi.fn(() => {
      decorationIds = model.deltaDecorations(decorationIds, [])
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller uses real model events and model-backed decoration ranges through this editor facade.
    const editorInstance = {
      getModel: () => model,
      createDecorationsCollection: () => ({ set, clear }),
      onDidChangeModelContent: (listener: (event: editor.IModelContentChangedEvent) => void) =>
        model.onDidChangeContent(listener)
    } as unknown as editor.IStandaloneCodeEditor
    const controller = createMarkdownDocLinkDecorationController(editorInstance, () => language)
    return {
      controller,
      set,
      clear,
      ranges: () => decorationIds.map((id) => model.getDecorationRange(id))
    }
  })
  getValue.mockClear()
  getLineContent.mockClear()
  panes.forEach((pane) => pane.set.mockClear())
  return {
    model,
    getValue,
    getLineContent,
    panes,
    setLanguage: (value: string) => {
      language = value
    }
  }
}

function settleDecorations() {
  vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS)
}

describe('createMarkdownDocLinkDecorationController', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const model of monaco.editor.getModels()) {
      model.dispose()
    }
  })

  it.each([1_000, 10_000])(
    'skips full scans for ordinary insertions among %i lines',
    (lineCount) => {
      vi.useFakeTimers()
      for (const paneCount of [1, 10]) {
        const fixture = mountController(`${'plain line\n'.repeat(lineCount)}[[Target]]`, paneCount)
        const initialRanges = fixture.panes.map((pane) => pane.ranges())
        for (let edit = 0; edit < 3; edit += 1) {
          fixture.model.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: 'x' }])
          settleDecorations()
        }
        expect(fixture.getValue).not.toHaveBeenCalled()
        expect(fixture.panes.every((pane) => pane.set.mock.calls.length === 0)).toBe(true)
        expect(fixture.panes.map((pane) => pane.ranges())).toEqual(initialRanges)
        fixture.panes.forEach((pane) => pane.controller.dispose())
      }
    }
  )

  it('handles several plain insertion ranges without rebuilding link decorations', () => {
    vi.useFakeTimers()
    const { model, getValue, panes } = mountController('plain\nanother\n[[Target]]')
    model.applyEdits([
      { range: new monaco.Range(1, 1, 1, 1), text: 'first' },
      { range: new monaco.Range(2, 1, 2, 1), text: 'second' }
    ])
    settleDecorations()
    expect(getValue).not.toHaveBeenCalled()
    expect(panes[0].ranges()).toEqual([new monaco.Range(3, 1, 3, 11)])
    panes[0].controller.dispose()
  })

  it('does not reuse a scan from a different actual model with the same version', () => {
    vi.useFakeTimers()
    const first = monaco.editor.createModel('first\n[[Old]]')
    const second = monaco.editor.createModel('second\n[[New]]')
    let currentModel = first
    const read = vi.spyOn(second, 'getValue')
    const set = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this facade forwards real model events and records the controller's decoration output across a model swap.
    const editorInstance = {
      getModel: () => currentModel,
      createDecorationsCollection: () => ({ set, clear: vi.fn() }),
      onDidChangeModelContent: (listener: (event: editor.IModelContentChangedEvent) => void) => {
        const subscriptions = [
          first.onDidChangeContent(listener),
          second.onDidChangeContent(listener)
        ]
        return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) }
      }
    } as unknown as editor.IStandaloneCodeEditor
    const controller = createMarkdownDocLinkDecorationController(editorInstance, () => 'markdown')
    currentModel = second
    second.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: 'x' }])
    settleDecorations()
    expect(read).toHaveBeenCalledOnce()
    expect(set).toHaveBeenLastCalledWith([
      {
        range: new monaco.Range(2, 1, 2, 8),
        options: { inlineClassName: 'monaco-markdown-doc-link', stickiness: 1 }
      }
    ])
    controller.dispose()
  })

  it('keeps the debounce fallback until a structural edit has been scanned', () => {
    vi.useFakeTimers()
    const { model, getValue, panes } = mountController('plain\n[[Target]]')
    model.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: '[' }])
    vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS - 1)
    model.applyEdits([{ range: new monaco.Range(2, 1, 2, 1), text: 'x' }])
    vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS - 1)
    expect(getValue).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(getValue).toHaveBeenCalledOnce()
    expect(panes[0].set).toHaveBeenCalledOnce()
    expect(panes[0].ranges()).toEqual([new monaco.Range(2, 2, 2, 12)])
    panes[0].controller.dispose()
  })

  it.each([
    { initial: '[[Target]]', range: new monaco.Range(1, 3, 1, 3), text: 'Other' },
    { initial: 'plain\n[[Target]]', range: new monaco.Range(1, 1, 1, 1), text: '\n' },
    { initial: 'plain\n[[Target]]', range: new monaco.Range(1, 1, 1, 2), text: '' },
    { initial: 'plain\n[[Target]]', range: new monaco.Range(1, 1, 1, 1), text: '```' },
    { initial: 'plain\n[[Target]]', range: new monaco.Range(1, 1, 1, 1), text: '~~~' },
    { initial: '`plain`\n[[Target]]', range: new monaco.Range(1, 2, 1, 2), text: 'x' },
    { initial: 'plain\n[[Target]]', range: new monaco.Range(1, 1, 1, 1), text: '[[New]]' }
  ])('rescans structural and deletion changes: $initial → $text', ({ initial, range, text }) => {
    vi.useFakeTimers()
    const { model, getValue, panes } = mountController(initial)
    model.applyEdits([{ range, text }])
    settleDecorations()
    expect(getValue).toHaveBeenCalledOnce()
    expect(panes[0].ranges()).toEqual(getMarkdownDocLinkDecorationRanges(model.getValue()))
    panes[0].controller.dispose()
  })

  it('refreshes after flush, language transitions, and Undo', async () => {
    vi.useFakeTimers()
    const { model, getValue, panes, setLanguage } = mountController('plain\n[[Target]]')
    model.pushStackElement()
    model.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: 'x' }], () => null)
    model.pushStackElement()
    settleDecorations()
    expect(getValue).not.toHaveBeenCalled()
    await model.undo()
    settleDecorations()
    expect(getValue).toHaveBeenCalledOnce()
    model.setValue('[[Replacement]]')
    settleDecorations()
    expect(panes[0].ranges()).toEqual([new monaco.Range(1, 1, 1, 16)])
    setLanguage('plaintext')
    panes[0].controller.refresh()
    expect(panes[0].ranges()).toEqual([])
    setLanguage('markdown')
    panes[0].controller.refresh()
    settleDecorations()
    expect(panes[0].ranges()).toEqual([new monaco.Range(1, 1, 1, 16)])
    panes[0].controller.dispose()
  })

  it('cancels pending decoration rebuilds on dispose', () => {
    vi.useFakeTimers()
    const { model, getValue, panes } = mountController('[[initial]]')
    model.setValue('[[next]]')
    getValue.mockClear()
    panes[0].controller.dispose()
    settleDecorations()
    expect(getValue).not.toHaveBeenCalled()
    expect(panes[0].set).not.toHaveBeenCalled()
    expect(panes[0].clear).toHaveBeenCalledOnce()
  })
})
