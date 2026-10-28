// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMonacoContentSyncBridge } from './use-monaco-content-sync-bridge'
import { beginEditorLargePaste } from './editor-large-paste-in-flight'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync
} from './monaco-programmatic-sync'

vi.mock('./editor-stale-mount-guard', () => ({ mayPushTabTextIntoModel: () => true }))

afterEach(() => {
  cleanup()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

function mountBridge(model: editor.ITextModel, onContentChange = vi.fn()) {
  const getValue = vi.fn(() => model.getValue())
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge uses this facade's real model event, text, and undo boundary.
  const mountedEditor = {
    getModel: () => model,
    getValue,
    onDidChangeModelContent: (listener: (event: editor.IModelContentChangedEvent) => void) =>
      model.onDidChangeContent(listener),
    pushUndoStop: () => {
      model.pushStackElement()
      return true
    }
  } as unknown as editor.IStandaloneCodeEditor
  const editorRef: { current: editor.IStandaloneCodeEditor | null } = { current: mountedEditor }
  const contentRef = { current: model.getValue() }
  const bridge = renderHook(
    ({ content, publish }) =>
      useMonacoContentSyncBridge({
        editorRef,
        mountedEditor,
        content,
        contentRef,
        contentSyncModeRef: { current: 'undoable' },
        modelKey: model.uri.toString(),
        onContentChange: publish
      }),
    { initialProps: { content: contentRef.current, publish: onContentChange } }
  )
  return { ...bridge, getValue, onContentChange, editorRef }
}

describe('Monaco content event admission', () => {
  it.each([1_000, 10_000].flatMap((lines) => [1, 10].map((paneCount) => ({ lines, paneCount }))))(
    'shares external reconciliation snapshots across $paneCount panes of $lines lines',
    async ({ lines, paneCount }) => {
      const initial = 'ordinary source line\n'.repeat(lines)
      const model = monaco.editor.createModel(initial)
      const panes = Array.from({ length: paneCount }, () => mountBridge(model))
      const reads = vi.spyOn(model, 'getValue')
      try {
        for (let update = 0; update < 3; update += 1) {
          const content = `${initial}update ${update}`
          for (const pane of panes) {
            pane.rerender({ content, publish: pane.onContentChange })
          }
          await Promise.resolve()
        }
        expect(reads).toHaveBeenCalledTimes(paneCount === 1 ? 3 : 6)
        for (const pane of panes) {
          expect(pane.onContentChange).not.toHaveBeenCalled()
        }
      } finally {
        reads.mockRestore()
      }
      expect(model.getValue()).toBe(`${initial}update 2`)
    }
  )

  it.each([1, 10])('materializes each model version once for %i pane publishers', (paneCount) => {
    const model = monaco.editor.createModel('line\n'.repeat(10_000))
    const panes = Array.from({ length: paneCount }, () => mountBridge(model))
    for (const value of ['first edit', 'second edit']) {
      act(() => model.setValue(value))
      for (const pane of panes) {
        expect(pane.onContentChange).toHaveBeenLastCalledWith(value)
      }
    }
    expect(panes.reduce((count, pane) => count + pane.getValue.mock.calls.length, 0)).toBe(2)
    for (const pane of panes) {
      expect(pane.onContentChange).toHaveBeenCalledTimes(2)
    }
  })

  it('keeps models with the same version independent', () => {
    const firstModel = monaco.editor.createModel('initial')
    const secondModel = monaco.editor.createModel('initial')
    const first = mountBridge(firstModel)
    const second = mountBridge(secondModel)
    act(() => {
      firstModel.setValue('first model')
      secondModel.setValue('second model')
    })
    expect(firstModel.getVersionId()).toBe(secondModel.getVersionId())
    expect(first.getValue).toHaveBeenCalledOnce()
    expect(second.getValue).toHaveBeenCalledOnce()
    expect(first.onContentChange).toHaveBeenCalledExactlyOnceWith('first model')
    expect(second.onContentChange).toHaveBeenCalledExactlyOnceWith('second model')
  })

  it('reads the new version when a publisher edits the model during event delivery', () => {
    const model = monaco.editor.createModel('initial')
    const publisher = vi.fn((value: string) => {
      if (value === 'outer edit') {
        model.setValue('nested edit')
      }
    })
    const first = mountBridge(model, publisher)
    const sibling = mountBridge(model)
    act(() => model.setValue('outer edit'))
    expect(publisher.mock.calls.map(([value]) => value)).toEqual(['outer edit', 'nested edit'])
    expect(sibling.onContentChange.mock.calls.map(([value]) => value)).toEqual([
      'nested edit',
      'nested edit'
    ])
    expect(first.getValue.mock.calls.length + sibling.getValue.mock.calls.length).toBe(2)
    expect(first.result.current.lastSyncedContentRef.current).toBe('nested edit')
    expect(sibling.result.current.lastSyncedContentRef.current).toBe('nested edit')
  })

  it('reads genuine edits once and follows the current publisher without retaining a subscription', () => {
    const model = monaco.editor.createModel('initial')
    const bridge = mountBridge(model)
    act(() => model.setValue('typed'))
    expect(bridge.getValue).toHaveBeenCalledOnce()
    expect(bridge.onContentChange).toHaveBeenCalledExactlyOnceWith('typed')

    const nextPublisher = vi.fn()
    bridge.rerender({ content: 'typed', publish: nextPublisher })
    act(() => model.setValue('second edit'))
    expect(bridge.getValue).toHaveBeenCalledTimes(2)
    expect(nextPublisher).toHaveBeenCalledExactlyOnceWith('second edit')
    expect(bridge.onContentChange).toHaveBeenCalledOnce()

    bridge.unmount()
    act(() => model.setValue('after close'))
    expect(bridge.getValue).toHaveBeenCalledTimes(2)
    expect(nextPublisher).toHaveBeenCalledOnce()
  })

  it('skips intermediate paste reads and publication in every pane sharing the model', () => {
    const model = monaco.editor.createModel('initial')
    const first = mountBridge(model)
    const sibling = mountBridge(model)
    const endPaste = beginEditorLargePaste(model.uri.toString())
    first.result.current.isApplyingLargePasteRef.current = true
    try {
      act(() => {
        model.setValue('first chunk')
        model.setValue('final chunk')
      })
      expect(first.getValue).not.toHaveBeenCalled()
      expect(sibling.getValue).not.toHaveBeenCalled()
      expect(first.onContentChange).not.toHaveBeenCalled()
      expect(sibling.onContentChange).not.toHaveBeenCalled()
    } finally {
      first.result.current.isApplyingLargePasteRef.current = false
      endPaste()
    }
    act(() => model.setValue('after paste'))
    expect(first.getValue).toHaveBeenCalledOnce()
    expect(sibling.getValue).not.toHaveBeenCalled()
    expect(first.onContentChange).toHaveBeenCalledExactlyOnceWith('after paste')
    expect(sibling.onContentChange).toHaveBeenCalledExactlyOnceWith('after paste')
  })

  it('does not read programmatic echoes, while external text and later user edits still reach both panes', () => {
    const model = monaco.editor.createModel('initial')
    const first = mountBridge(model)
    const sibling = mountBridge(model)
    first.rerender({ content: 'external update', publish: first.onContentChange })
    expect(model.getValue()).toBe('external update')
    expect(first.getValue).not.toHaveBeenCalled()
    expect(sibling.getValue).not.toHaveBeenCalled()
    expect(first.onContentChange).not.toHaveBeenCalled()
    expect(sibling.onContentChange).not.toHaveBeenCalled()

    const key = model.uri.toString()
    beginProgrammaticContentSync(key)
    try {
      act(() => model.setValue('another owner update'))
    } finally {
      endProgrammaticContentSync(key)
    }
    expect(first.getValue).not.toHaveBeenCalled()
    expect(sibling.getValue).not.toHaveBeenCalled()
    act(() => model.setValue('user edit'))
    expect(first.onContentChange).toHaveBeenCalledExactlyOnceWith('user edit')
    expect(sibling.onContentChange).toHaveBeenCalledExactlyOnceWith('user edit')
  })

  it('does not materialize events from an editor that no longer owns the mounted ref', () => {
    const model = monaco.editor.createModel('initial')
    const bridge = mountBridge(model)
    bridge.editorRef.current = null
    act(() => model.setValue('retired editor'))
    expect(bridge.getValue).not.toHaveBeenCalled()
    expect(bridge.onContentChange).not.toHaveBeenCalled()
  })
})
