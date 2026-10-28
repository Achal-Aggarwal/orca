// @vitest-environment happy-dom
import { useMemo, useState } from 'react'
import type { editor } from 'monaco-editor'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpynbCellSource } from './IpynbCellEditor'
import { parseIpynb } from './ipynb-parse'
import {
  getIpynbCellKey,
  hasIpynbSourceDraft,
  useIpynbDocumentEditing
} from './useIpynbDocumentEditing'

const liveModels = vi.hoisted(() => {
  const models: editor.ITextModel[] = []
  return models
})
const activeWidgetModel = vi.hoisted((): { current?: editor.ITextModel } => ({}))
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
        create: (_container: HTMLElement, { model }: { model: editor.ITextModel }) => {
          activeWidgetModel.current = model
          return {
            getModel: () => model,
            getContentHeight: () => 28,
            layout: widgetCalls.layout,
            onDidContentSizeChange: () => ({ dispose: vi.fn() }),
            restoreViewState: vi.fn(),
            saveViewState: () => null,
            getTargetAtClientPoint: () => null,
            setPosition: vi.fn(),
            focus: widgetCalls.focus,
            onDidBlurEditorWidget: () => ({ dispose: vi.fn() }),
            addCommand: vi.fn(),
            updateOptions: widgetCalls.updateOptions,
            pushUndoStop: () => {
              model.pushStackElement()
              return true
            },
            dispose: vi.fn()
          }
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
  onDirtyStateHint,
  fileId = 'external-notebook',
  viewKey = 'default',
  editEpoch = 0
}: {
  content: string
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  fileId?: string
  viewKey?: string
  editEpoch?: number
}): React.JSX.Element {
  const notebook = useMemo(() => parseIpynb(content), [content])
  const [editingCellKey, setEditingCellKey] = useState<string | null>(null)
  const editing = useIpynbDocumentEditing({
    content,
    fileId,
    notebook,
    onContentChange,
    onDirtyStateHint,
    onDeactivateEditor: () => setEditingCellKey(null)
  })
  return (
    <div ref={editing.setRootRef}>
      {notebook.cells.map((cell, index) => {
        const key = getIpynbCellKey(cell, index)
        return (
          <IpynbCellSource
            key={key}
            modelKey={JSON.stringify([fileId, viewKey, key, editEpoch])}
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
  const model = activeWidgetModel.current
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
  activeWidgetModel.current = undefined
  for (const model of liveModels.splice(0)) {
    if (!model.isDisposed()) {
      model.dispose()
    }
  }
  vi.useRealTimers()
})

describe('active notebook cell external reload', () => {
  it('restores undo after whole-view unmount without retaining the disposed model', async () => {
    const callbacks = {
      onContentChange: vi.fn<(content: string) => void>(),
      onDirtyStateHint: vi.fn()
    }
    const original = notebookContent([{ id: 'tab-return', source: 'original source' }])
    const firstView = render(<NotebookCells content={original} {...callbacks} />)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'original source' }), { button: 0 })
    const firstModel = activeModel()
    appendText(firstModel, '!')
    const edited = callbacks.onContentChange.mock.calls.at(-1)?.[0]
    expect(edited).toBeDefined()
    firstView.unmount()
    expect(firstModel.isDisposed()).toBe(true)

    render(<NotebookCells content={edited ?? ''} {...callbacks} />)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'original source!' }), { button: 0 })
    const returnedModel = activeModel()
    expect(returnedModel).not.toBe(firstModel)
    callbacks.onDirtyStateHint.mockClear()
    await act(async () => {
      await returnedModel.undo()
    })
    expect(returnedModel.getValue()).toBe('original source')
    expect(callbacks.onDirtyStateHint).toHaveBeenCalledOnce()
    await act(async () => {
      await returnedModel.redo()
    })
    expect(returnedModel.getValue()).toBe('original source!')
  })

  it.each([{ fileId: 'another-notebook' }, { viewKey: 'another-view' }, { editEpoch: 1 }])(
    'does not borrow undo from another cell owner: %j',
    async (owner) => {
      const callbacks = {
        onContentChange: vi.fn<(content: string) => void>(),
        onDirtyStateHint: vi.fn()
      }
      const firstView = render(
        <NotebookCells
          content={notebookContent([{ id: 'owner-isolation', source: 'original source' }])}
          {...callbacks}
        />
      )
      fireEvent.mouseDown(screen.getByRole('button', { name: 'original source' }), { button: 0 })
      appendText(activeModel(), '!')
      const edited = callbacks.onContentChange.mock.calls.at(-1)?.[0]
      expect(edited).toBeDefined()
      firstView.unmount()

      render(<NotebookCells content={edited ?? ''} {...callbacks} {...owner} />)
      fireEvent.mouseDown(screen.getByRole('button', { name: 'original source!' }), { button: 0 })
      const otherModel = activeModel()
      await act(async () => {
        await otherModel.undo()
      })
      expect(otherModel.getValue()).toBe('original source!')
    }
  )

  it('drops disposed history when the source changed while the notebook view was absent', async () => {
    const callbacks = { onContentChange: vi.fn(), onDirtyStateHint: vi.fn() }
    const firstView = render(
      <NotebookCells
        content={notebookContent([{ id: 'absent-reload', source: 'original source' }])}
        {...callbacks}
      />
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'original source' }), { button: 0 })
    appendText(activeModel(), '!')
    firstView.unmount()
    render(
      <NotebookCells
        content={notebookContent([{ id: 'absent-reload', source: 'new source from disk' }])}
        {...callbacks}
      />
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'new source from disk' }), { button: 0 })
    const returnedModel = activeModel()
    await act(async () => {
      await returnedModel.undo()
    })
    expect(returnedModel.getValue()).toBe('new source from disk')
  })

  it('retains per-cell undo across activation changes and releases models with their cell owners', async () => {
    const callbacks = { onContentChange: vi.fn(), onDirtyStateHint: vi.fn() }
    const content = notebookContent([
      { id: 'a', source: 'first source' },
      { id: 'b', source: 'second source' }
    ])
    const { rerender, unmount } = render(<NotebookCells content={content} {...callbacks} />)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'first source' }), { button: 0 })
    const firstModel = activeModel()
    appendText(firstModel, '!')
    fireEvent.mouseDown(screen.getByRole('button', { name: 'second source' }), { button: 0 })
    const secondModel = activeModel()
    appendText(secondModel, '?')
    fireEvent.mouseDown(screen.getByRole('button', { name: 'first source!' }), { button: 0 })
    const returnedModel = activeModel()
    callbacks.onDirtyStateHint.mockClear()
    await act(async () => {
      await returnedModel.undo()
    })

    expect(returnedModel.getValue()).toBe('first source')
    expect(callbacks.onDirtyStateHint).toHaveBeenCalledOnce()
    expect(secondModel.getValue()).toBe('second source?')
    expect(returnedModel).toBe(firstModel)
    expect(liveModels).toEqual([firstModel, secondModel])
    rerender(
      <NotebookCells
        content={notebookContent([{ id: 'b', source: 'second source?' }])}
        {...callbacks}
      />
    )
    expect(firstModel.isDisposed()).toBe(true)
    expect(secondModel.isDisposed()).toBe(false)
    unmount()
    expect(secondModel.isDisposed()).toBe(true)
  })

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
