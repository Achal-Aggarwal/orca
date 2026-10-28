// @vitest-environment happy-dom
import { useMemo, useState } from 'react'
import type { editor } from 'monaco-editor'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpynbCellSource } from './IpynbCellEditor'
import { parseIpynb } from './ipynb-parse'
import { beginMonacoLargePasteLifecycle } from './monaco-large-paste-lifecycle'
import type { MonacoPasteEditor } from './monaco-large-text-paste'
import {
  getIpynbCellKey,
  hasIpynbSourceDraft,
  useIpynbDocumentEditing
} from './useIpynbDocumentEditing'

const liveModels = vi.hoisted(() => {
  const models: editor.ITextModel[] = []
  return models
})
const liveEditors = vi.hoisted(() => {
  const instances: (MonacoPasteEditor & { blur: () => void })[] = []
  return instances
})
const widgetCalls = vi.hoisted(() => ({
  focus: vi.fn(),
  layout: vi.fn(),
  updateOptions: vi.fn<(options: editor.IEditorOptions) => void>()
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => {
  const state = {
    settings: undefined,
    editorFontZoomLevel: 0,
    editorBufferIdOf: {},
    editorBufferViews: {}
  }
  return {
    useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => true }))
vi.mock('./MonacoCodeExcerpt', () => ({ useMonacoColorizedLines: () => [] }))
vi.mock('./editor-shortcuts', () => ({ installMonacoEditorFindShortcut: () => () => {} }))
vi.mock('@/lib/monaco-setup', async () => {
  const actual = await import('monaco-editor/esm/vs/editor/editor.api.js')
  for (const id of ['python', 'javascript', 'markdown']) {
    actual.languages.register({ id })
  }
  return {
    monaco: {
      ...actual,
      editor: {
        ...actual.editor,
        setTheme: vi.fn(),
        createModel: (...args: Parameters<typeof actual.editor.createModel>) => {
          const model = actual.editor.createModel(...args)
          liveModels.push(model)
          return model
        },
        create: (container: HTMLElement, { model }: { model: editor.ITextModel }) => {
          const blurListeners = new Set<() => void>()
          const instance = {
            getModel: () => model,
            getContainerDomNode: () => container,
            hasTextFocus: () => true,
            getSelections: () => null,
            getSelection: () => null,
            setSelection: () => {},
            executeEdits: () => false,
            getContentHeight: () => 28,
            layout: widgetCalls.layout,
            onDidContentSizeChange: () => ({ dispose: vi.fn() }),
            restoreViewState: vi.fn(),
            saveViewState: () => null,
            getTargetAtClientPoint: () => null,
            setPosition: vi.fn(),
            focus: widgetCalls.focus,
            onDidBlurEditorWidget: (listener: () => void) => {
              blurListeners.add(listener)
              return { dispose: () => blurListeners.delete(listener) }
            },
            blur: () => blurListeners.forEach((listener) => listener()),
            addCommand: vi.fn(),
            updateOptions: widgetCalls.updateOptions,
            pushUndoStop: () => {
              model.pushStackElement()
              return true
            },
            dispose: vi.fn()
          }
          liveEditors.push(instance)
          return instance
        }
      }
    }
  }
})

function notebookContent(
  cells: { id: string; source: string; kind?: 'code' | 'markdown' }[],
  language = 'python'
): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: language } },
    cells: cells.map(({ id, source, kind }) => ({
      id,
      cell_type: kind ?? 'code',
      metadata: {},
      execution_count: null,
      outputs: [],
      source: [source]
    }))
  })
}

function NotebookCells({
  content,
  onContentChange,
  onDirtyStateHint
}: {
  content: string
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
}): React.JSX.Element {
  const notebook = useMemo(() => parseIpynb(content), [content])
  const [editingCellKey, setEditingCellKey] = useState<string | null>(null)
  const editing = useIpynbDocumentEditing({
    content,
    fileId: 'external-notebook',
    notebook,
    onContentChange,
    onDirtyStateHint,
    onDeactivateEditor: () => setEditingCellKey(null)
  })
  return (
    <div ref={editing.setRootRef}>
      <button onClick={() => editing.flushSourceDrafts()}>Save snapshot</button>
      {notebook.cells.map((cell, index) => {
        const key = getIpynbCellKey(cell, index)
        return (
          <IpynbCellSource
            registerSourceEditorFlush={editing.registerSourceEditorFlush}
            key={key}
            cell={cell}
            source={
              hasIpynbSourceDraft(editing.sourceDrafts, key)
                ? (editing.sourceDrafts[key] ?? '')
                : cell.source
            }
            active={editingCellKey === key}
            onActivate={() => setEditingCellKey(key)}
            onDeactivate={() => setEditingCellKey(null)}
            onChange={(source) => editing.updateCellSource(index, source)}
          />
        )
      })}
    </div>
  )
}

function activeModel(): editor.ITextModel {
  const model = liveModels.at(-1)
  if (!model) {
    throw new Error('No notebook cell editor was created')
  }
  return model
}

function appendText(model: editor.ITextModel, text: string): void {
  const end = model.getFullModelRange()
  act(() => {
    model.pushEditOperations(
      [],
      [{ range: { ...end, startLineNumber: end.endLineNumber, startColumn: end.endColumn }, text }],
      () => null
    )
    vi.advanceTimersByTime(400)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  liveEditors.splice(0)
  for (const model of liveModels.splice(0)) {
    if (!model.isDisposed()) {
      model.dispose()
    }
  }
  vi.useRealTimers()
})

describe('notebook source large paste publication', () => {
  it('does not release source deferral while an overlapping paste is still active', () => {
    const onContentChange = vi.fn()
    const onDirtyStateHint = vi.fn()
    render(
      <NotebookCells
        content={notebookContent([{ id: 'a', source: 'base' }])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'base' }), { button: 0 })
    const model = activeModel()
    const instance = liveEditors.at(-1)
    if (!instance) {
      throw new Error('Missing active source editor')
    }
    const first = beginMonacoLargePasteLifecycle(instance)
    appendText(model, '-one')
    const second = beginMonacoLargePasteLifecycle(instance)
    appendText(model, '-two')
    act(() => second?.({ status: 'pasted', mode: 'chunked', byteLength: 100000, chunksWritten: 1 }))
    appendText(model, '-three')
    expect(onContentChange).not.toHaveBeenCalled()
    act(() =>
      first?.({
        status: 'cancelled',
        reason: 'target-unavailable',
        byteLength: 100000,
        chunksWritten: 2
      })
    )
    act(() => vi.advanceTimersByTime(400))
    expect(onContentChange).toHaveBeenCalledTimes(1)
    expect(parseIpynb(onContentChange.mock.calls[0]?.[0] ?? '').cells[0]?.source).toBe(
      'base-one-two-three'
    )
  })

  it('keeps later chunks pending after a partial Save and publishes the remaining source at completion', () => {
    const onContentChange = vi.fn()
    const onDirtyStateHint = vi.fn()
    render(
      <NotebookCells
        content={notebookContent([{ id: 'a', source: 'base' }])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'base' }), { button: 0 })
    const model = activeModel()
    const instance = liveEditors.at(-1)
    if (!instance) {
      throw new Error('Missing active source editor')
    }
    const finish = beginMonacoLargePasteLifecycle(instance)
    appendText(model, '-first')
    fireEvent.click(screen.getByRole('button', { name: 'Save snapshot' }))
    expect(parseIpynb(onContentChange.mock.calls[0]?.[0] ?? '').cells[0]?.source).toBe('base-first')
    appendText(model, '-second')
    expect(onContentChange).toHaveBeenCalledTimes(1)
    act(() => finish?.({ status: 'pasted', mode: 'chunked', byteLength: 100000, chunksWritten: 2 }))
    act(() => vi.advanceTimersByTime(400))
    expect(onContentChange).toHaveBeenCalledTimes(2)
    expect(parseIpynb(onContentChange.mock.calls[1]?.[0] ?? '').cells[0]?.source).toBe(
      'base-first-second'
    )
  })

  it('settles source into its original cell after external reordering changes the callback index', () => {
    const onContentChange = vi.fn()
    const onDirtyStateHint = vi.fn()
    const first = { id: 'a', source: 'base' }
    const second = { id: 'b', source: 'other' }
    const { rerender } = render(
      <NotebookCells
        content={notebookContent([first, second])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'base' }), { button: 0 })
    const model = activeModel()
    const instance = liveEditors.at(-1)
    if (!instance) {
      throw new Error('Missing active source editor')
    }
    const finish = beginMonacoLargePasteLifecycle(instance)
    appendText(model, '-partial')
    rerender(
      <NotebookCells
        content={notebookContent([second, first])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    act(() =>
      finish?.({
        status: 'cancelled',
        reason: 'target-unavailable',
        byteLength: 100000,
        chunksWritten: 1
      })
    )
    act(() => vi.advanceTimersByTime(400))
    expect(
      parseIpynb(onContentChange.mock.calls[0]?.[0] ?? '').cells.map(({ id, source }) => ({
        id,
        source
      }))
    ).toEqual([second, { ...first, source: 'base-partial' }])
  })

  for (const chunks of [5, 50]) {
    it(`defers ${chunks} chunks before one source publication and preserves Undo`, async () => {
      const onContentChange = vi.fn()
      const onDirtyStateHint = vi.fn()
      render(
        <NotebookCells
          content={notebookContent([{ id: 'a', source: 'base' }])}
          {...{ onContentChange, onDirtyStateHint }}
        />
      )
      fireEvent.mouseDown(screen.getByRole('button', { name: 'base' }), { button: 0 })
      const model = activeModel()
      const instance = liveEditors.at(-1)
      if (!instance) {
        throw new Error('Missing active source editor')
      }
      const reads = vi.spyOn(model, 'getValue')
      const finish = beginMonacoLargePasteLifecycle(instance)
      model.pushStackElement()
      for (let i = 0; i < chunks; i += 1) {
        appendText(model, 'x'.repeat(16384))
      }
      expect(reads).not.toHaveBeenCalled()
      expect(onContentChange).not.toHaveBeenCalled()
      act(() =>
        finish?.({
          status: 'pasted',
          mode: 'chunked',
          byteLength: chunks * 16384,
          chunksWritten: chunks
        })
      )
      model.pushStackElement()
      expect(reads).toHaveBeenCalledTimes(1)
      act(() => vi.advanceTimersByTime(400))
      expect(onContentChange).toHaveBeenCalledTimes(1)
      expect(parseIpynb(onContentChange.mock.calls[0]?.[0] ?? '').cells[0]?.source).toBe(
        `base${'x'.repeat(chunks * 16384)}`
      )
      await act(async () => model.undo())
      act(() => vi.advanceTimersByTime(400))
      expect(parseIpynb(onContentChange.mock.calls.at(-1)?.[0] ?? '').cells[0]?.source).toBe('base')
    })
  }

  for (const boundary of ['save', 'deactivate', 'unmount'] as const) {
    it(`drains partial source before ${boundary} and does not publish again after settlement`, () => {
      const onContentChange = vi.fn()
      const onDirtyStateHint = vi.fn()
      const { unmount } = render(
        <NotebookCells
          content={notebookContent([{ id: 'a', source: 'base' }])}
          {...{ onContentChange, onDirtyStateHint }}
        />
      )
      fireEvent.mouseDown(screen.getByRole('button', { name: 'base' }), { button: 0 })
      const model = activeModel()
      const instance = liveEditors.at(-1)
      if (!instance) {
        throw new Error('Missing active source editor')
      }
      const finish = beginMonacoLargePasteLifecycle(instance)
      appendText(model, '-partial')
      expect(onContentChange).not.toHaveBeenCalled()
      if (boundary === 'save') {
        fireEvent.click(screen.getByRole('button', { name: 'Save snapshot' }))
      } else if (boundary === 'deactivate') {
        act(() => instance.blur())
      } else {
        unmount()
      }
      act(() => vi.advanceTimersByTime(400))
      expect(onContentChange).toHaveBeenCalledTimes(1)
      expect(parseIpynb(onContentChange.mock.calls[0]?.[0] ?? '').cells[0]?.source).toBe(
        'base-partial'
      )
      act(() =>
        finish?.({
          status: 'cancelled',
          reason: 'target-unavailable',
          byteLength: 100000,
          chunksWritten: 1
        })
      )
      act(() => vi.advanceTimersByTime(400))
      expect(onContentChange).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })
  }
})

describe('active notebook cell external reload', () => {
  it('shows the new source without dirtying the clean notebook or recreating the model', () => {
    const onContentChange = vi.fn<(content: string) => void>()
    const onDirtyStateHint = vi.fn<(dirty: boolean) => void>()
    const initialContent = notebookContent([{ id: 'a', source: 'original source' }])
    const { rerender } = render(
      <NotebookCells content={initialContent} {...{ onContentChange, onDirtyStateHint }} />
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'original source' }), { button: 0 })
    const model = activeModel()
    expect(model.getValue()).toBe('original source')
    expect(onDirtyStateHint).not.toHaveBeenCalled()

    rerender(
      <NotebookCells
        content={notebookContent([{ id: 'a', source: 'updated from disk' }])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )

    expect(liveModels).toEqual([model])
    expect(model.getValue()).toBe('updated from disk')
    expect(onContentChange).not.toHaveBeenCalled()
    expect(onDirtyStateHint).not.toHaveBeenCalled()
    expect(widgetCalls.focus).toHaveBeenCalledOnce()
    appendText(model, '!')
    const committedContent = onContentChange.mock.calls.at(-1)?.[0]
    expect(committedContent).toBeDefined()
    expect(parseIpynb(committedContent ?? '').cells[0]?.source).toBe('updated from disk!')
  })

  it('writes edits to the same cell after a clean external reload reorders it', () => {
    const onContentChange = vi.fn<(content: string) => void>()
    const onDirtyStateHint = vi.fn<(dirty: boolean) => void>()
    const first = { id: 'a', source: 'active source' }
    const second = { id: 'b', source: 'other source' }
    const { rerender } = render(
      <NotebookCells
        content={notebookContent([first, second])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: first.source }), { button: 0 })
    const model = activeModel()
    expect(onDirtyStateHint).not.toHaveBeenCalled()

    rerender(
      <NotebookCells
        content={notebookContent([second, first])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    expect(liveModels).toEqual([model])
    expect(onDirtyStateHint).not.toHaveBeenCalled()
    appendText(model, '!')

    const committedContent = onContentChange.mock.calls.at(-1)?.[0]
    expect(committedContent).toBeDefined()
    const cells = parseIpynb(committedContent ?? '').cells
    expect(cells.map(({ id, source }) => ({ id, source }))).toEqual([
      second,
      { ...first, source: 'active source!' }
    ])
  })

  it('retains undo for external source changes and treats undo as a user edit', async () => {
    const onContentChange = vi.fn<(content: string) => void>()
    const onDirtyStateHint = vi.fn<(dirty: boolean) => void>()
    const { rerender } = render(
      <NotebookCells
        content={notebookContent([{ id: 'a', source: 'original source' }])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'original source' }), { button: 0 })
    const model = activeModel()
    rerender(
      <NotebookCells
        content={notebookContent([{ id: 'a', source: 'updated source' }])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )

    expect(model.canUndo()).toBe(true)
    expect(onDirtyStateHint).not.toHaveBeenCalled()
    await act(async () => {
      await model.undo()
      vi.advanceTimersByTime(400)
    })
    expect(model.getValue()).toBe('original source')
    expect(onDirtyStateHint).toHaveBeenCalledWith(true)
    const committedContent = onContentChange.mock.calls.at(-1)?.[0]
    expect(parseIpynb(committedContent ?? '').cells[0]?.source).toBe('original source')
  })

  it('updates language, wrapping and height when a clean reload changes the active cell', () => {
    const onContentChange = vi.fn<(content: string) => void>()
    const onDirtyStateHint = vi.fn<(dirty: boolean) => void>()
    const { rerender } = render(
      <NotebookCells
        content={notebookContent([{ id: 'a', source: 'original source' }])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'original source' }), { button: 0 })
    const model = activeModel()
    rerender(
      <NotebookCells
        content={notebookContent([{ id: 'a', source: 'updated source' }], 'javascript')}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    expect(model.getLanguageId()).toBe('javascript')
    expect(widgetCalls.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ wordWrap: 'off' })
    )
    widgetCalls.layout.mockClear()

    rerender(
      <NotebookCells
        content={notebookContent([
          { id: 'a', kind: 'markdown', source: '**Updated**\n\nParagraph' }
        ])}
        {...{ onContentChange, onDirtyStateHint }}
      />
    )
    expect(liveModels).toEqual([model])
    expect(model.getLanguageId()).toBe('markdown')
    expect(widgetCalls.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ wordWrap: 'on' })
    )
    expect(widgetCalls.layout).toHaveBeenCalled()
    expect(model.getValue()).toBe('**Updated**\n\nParagraph')
    expect(onDirtyStateHint).not.toHaveBeenCalled()
    expect(onContentChange).not.toHaveBeenCalled()
  })
})
