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
    expect(sibling.getValue).toHaveBeenCalledOnce()
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
