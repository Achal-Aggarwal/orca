// @vitest-environment happy-dom
import { useLayoutEffect, useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import type { editor } from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginMonacoLargePasteLifecycle } from '@/components/editor/monaco-large-paste-lifecycle'

const mounted = vi.hoisted(
  (): {
    instance: null | {
      getModel: () => editor.ITextModel | null
      getContainerDomNode: () => HTMLElement
      hasTextFocus: () => boolean
      getSelections: () => null
      getSelection: () => null
      setSelection: () => void
      executeEdits: () => boolean
      pushUndoStop: () => boolean
      dispose: () => void
    }
  } => ({ instance: null })
)

type PromptEditorStore = { settings: undefined; editorFontZoomLevel: number }
vi.mock('@/store', () => ({
  useAppStore: (select: (state: PromptEditorStore) => unknown) =>
    select({ settings: undefined, editorFontZoomLevel: 0 })
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('@/components/editor/editor-shortcuts', () => ({
  installMonacoEditorFindShortcut: () => () => {}
}))
vi.mock('@/lib/monaco-setup', async () => ({
  monaco: await import('monaco-editor/esm/vs/editor/editor.api.js')
}))
vi.mock('@monaco-editor/react', async () => {
  const monaco = await import('monaco-editor/esm/vs/editor/editor.api.js')
  return {
    default: function Editor(props: Record<string, unknown>) {
      const ref = useRef<HTMLDivElement>(null)
      const propsRef = useRef(props)
      useLayoutEffect(() => {
        propsRef.current = props
      }, [props])
      useLayoutEffect(() => {
        const container = ref.current
        if (!container) {
          throw new Error('Missing editor container')
        }
        const model = monaco.editor.createModel(
          typeof props.defaultValue === 'string' ? props.defaultValue : '',
          'plaintext'
        )
        const disposeListeners = new Set<() => void>()
        const instance = {
          getModel: () => model,
          getValue: () => model.getValue(),
          getContainerDomNode: () => container,
          hasTextFocus: () => true,
          getSelections: () => null,
          getSelection: () => null,
          setSelection: () => {},
          executeEdits: () => true,
          pushUndoStop: () => {
            model.pushStackElement()
            return true
          },
          onDidChangeModelContent: model.onDidChangeContent.bind(model),
          onDidDispose: (callback: () => void) => {
            disposeListeners.add(callback)
            return { dispose: () => disposeListeners.delete(callback) }
          },
          dispose: () => {
            disposeListeners.forEach((callback) => callback())
            disposeListeners.clear()
          }
        }
        mounted.instance = instance
        const wrapperListener =
          typeof props.onChange === 'function'
            ? model.onDidChangeContent(() => {
                const onChange = propsRef.current.onChange
                if (typeof onChange === 'function') {
                  onChange(model.getValue())
                }
              })
            : undefined
        if (typeof props.onMount === 'function') {
          props.onMount(instance, monaco)
        }
        return () => {
          instance.dispose()
          wrapperListener?.dispose()
          model.dispose()
          mounted.instance = null
        }
        // oxlint-disable-next-line react-hooks/exhaustive-deps -- match the wrapper's single widget lifetime.
      }, [])
      return <div ref={ref} />
    }
  }
})

import { AutomationEditorPromptEditor } from './AutomationEditorPromptEditor'

function currentEditor() {
  const instance = mounted.instance
  const model = instance?.getModel()
  if (!instance || !model) {
    throw new Error('Missing prompt editor/model')
  }
  return { instance, model }
}

function append(model: editor.ITextModel, text: string): void {
  const end = model.getFullModelRange()
  model.pushEditOperations(
    [],
    [{ range: { ...end, startLineNumber: end.endLineNumber, startColumn: end.endColumn }, text }],
    () => null
  )
}

afterEach(cleanup)

describe('automation prompt large paste publication', () => {
  it('drains the accepted prefix for Save and keeps subsequent chunks pending', () => {
    const onChange = vi.fn()
    let flush: (() => void) | undefined
    const unregister = vi.fn()
    const { unmount } = render(
      <AutomationEditorPromptEditor
        value="base"
        placeholder=""
        ariaLabel="Prompt"
        onChange={onChange}
        registerPromptFlush={(callback) => {
          flush = callback
          return unregister
        }}
      />
    )
    const { instance, model } = currentEditor()
    const reads = vi.spyOn(model, 'getValue')
    const finish = beginMonacoLargePasteLifecycle(instance)
    act(() => append(model, '-first'))
    expect(reads).not.toHaveBeenCalled()
    act(() => flush?.())
    expect(onChange).toHaveBeenCalledExactlyOnceWith('base-first')
    expect(reads).toHaveBeenCalledTimes(1)
    act(() => append(model, '-second'))
    expect(onChange).toHaveBeenCalledTimes(1)
    act(() => finish?.({ status: 'pasted', mode: 'chunked', byteLength: 100000, chunksWritten: 2 }))
    expect(onChange).toHaveBeenLastCalledWith('base-first-second')
    expect(reads).toHaveBeenCalledTimes(2)
    unmount()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('keeps overlapping pastes deferred until both original operations settle', () => {
    const onChange = vi.fn()
    render(
      <AutomationEditorPromptEditor
        value="base"
        placeholder=""
        ariaLabel="Prompt"
        onChange={onChange}
      />
    )
    const { instance, model } = currentEditor()
    const first = beginMonacoLargePasteLifecycle(instance)
    act(() => append(model, '-one'))
    const second = beginMonacoLargePasteLifecycle(instance)
    act(() => append(model, '-two'))
    act(() =>
      first?.({
        status: 'cancelled',
        reason: 'target-unavailable',
        byteLength: 100000,
        chunksWritten: 1
      })
    )
    expect(onChange).not.toHaveBeenCalled()
    act(() => append(model, '-three'))
    expect(onChange).not.toHaveBeenCalled()
    act(() => second?.({ status: 'pasted', mode: 'chunked', byteLength: 100000, chunksWritten: 2 }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('base-one-two-three')
    first?.({
      status: 'cancelled',
      reason: 'target-unavailable',
      byteLength: 100000,
      chunksWritten: 1
    })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  for (const chunks of [5, 50]) {
    it(`reads and publishes once for ${chunks} admitted model chunks and preserves Undo`, async () => {
      const onChange = vi.fn()
      render(
        <AutomationEditorPromptEditor
          value="base"
          placeholder=""
          ariaLabel="Prompt"
          onChange={onChange}
        />
      )
      const { instance, model } = currentEditor()
      const reads = vi.spyOn(model, 'getValue')
      const finish = beginMonacoLargePasteLifecycle(instance)
      model.pushStackElement()
      act(() => {
        for (let i = 0; i < chunks; i += 1) {
          append(model, 'x'.repeat(16384))
        }
      })
      expect(reads).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      act(() =>
        finish?.({
          status: 'pasted',
          mode: 'chunked',
          byteLength: chunks * 16384,
          chunksWritten: chunks
        })
      )
      model.pushStackElement()
      expect(reads).toHaveBeenCalledOnce()
      expect(onChange).toHaveBeenCalledExactlyOnceWith(`base${'x'.repeat(chunks * 16384)}`)
      await act(async () => model.undo())
      expect(onChange).toHaveBeenLastCalledWith('base')
    })
  }

  it('settles partial input to its captured publisher after disposal unregisters future starts', () => {
    const original = vi.fn()
    const replacement = vi.fn()
    const { rerender } = render(
      <AutomationEditorPromptEditor
        value="base"
        placeholder=""
        ariaLabel="Prompt"
        onChange={original}
      />
    )
    const { instance, model } = currentEditor()
    const finish = beginMonacoLargePasteLifecycle(instance)
    act(() => append(model, '-partial'))
    expect(original).not.toHaveBeenCalled()
    rerender(
      <AutomationEditorPromptEditor
        value="base"
        placeholder=""
        ariaLabel="Prompt"
        onChange={replacement}
      />
    )
    instance.dispose()
    expect(beginMonacoLargePasteLifecycle(instance)).toBeUndefined()
    act(() =>
      finish?.({
        status: 'cancelled',
        reason: 'target-unavailable',
        byteLength: 100000,
        chunksWritten: 1
      })
    )
    expect(original).toHaveBeenCalledExactlyOnceWith('base-partial')
    expect(replacement).not.toHaveBeenCalled()
  })

  it('skips rejected and disposed model publication', () => {
    const onChange = vi.fn()
    const { unmount } = render(
      <AutomationEditorPromptEditor
        value="base"
        placeholder=""
        ariaLabel="Prompt"
        onChange={onChange}
      />
    )
    const { instance } = currentEditor()
    const rejected = beginMonacoLargePasteLifecycle(instance)
    rejected?.({ status: 'rejected', reason: 'too-large', byteLength: 20000000, chunksWritten: 0 })
    expect(onChange).not.toHaveBeenCalled()
    const disposed = beginMonacoLargePasteLifecycle(instance)
    unmount()
    disposed?.({
      status: 'cancelled',
      reason: 'target-unavailable',
      byteLength: 100000,
      chunksWritten: 0
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps template rewrites undoable without publishing them as edits', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <AutomationEditorPromptEditor
        value="base"
        placeholder=""
        ariaLabel="Prompt"
        onChange={onChange}
      />
    )
    const { model } = currentEditor()
    rerender(
      <AutomationEditorPromptEditor
        value="template"
        placeholder=""
        ariaLabel="Prompt"
        onChange={onChange}
      />
    )
    expect(model.getValue()).toBe('template')
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => model.undo())
    expect(onChange).toHaveBeenCalledExactlyOnceWith('base')
  })
})
