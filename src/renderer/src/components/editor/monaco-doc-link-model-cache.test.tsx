// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createMarkdownDocLinkDecorationController,
  MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS
} from './monaco-markdown-doc-link-decorations'

const controllers: { dispose: () => void }[] = []
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  monaco.editor.getModels().forEach((model) => model.dispose())
  vi.useRealTimers()
})

function createPane(initialModel: editor.ITextModel) {
  let model = initialModel
  const set = vi.fn()
  const clear = vi.fn()
  const dispose = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller only uses these collection, model and subscription methods.
  const instance = {
    getModel: () => model,
    createDecorationsCollection: () => ({ set, clear }),
    onDidChangeModelContent: (listener: () => void) => {
      const subscription = initialModel.onDidChangeContent(listener)
      return {
        dispose: () => {
          dispose()
          subscription.dispose()
        }
      }
    }
  } as unknown as editor.IStandaloneCodeEditor
  const controller = createMarkdownDocLinkDecorationController(instance, () => 'markdown')
  controllers.push(controller)
  return {
    ...controller,
    set,
    clear,
    disposeSubscription: dispose,
    swapModel: (next: editor.ITextModel) => {
      model = next
      controller.refresh()
    }
  }
}

it('scans a shared model once per version and preserves the surviving pane and undo updates', () => {
  vi.useFakeTimers()
  const model = monaco.editor.createModel('[[one]]')
  const read = vi.spyOn(model, 'getValue')
  const first = createPane(model)
  const sibling = createPane(model)
  expect(read).toHaveBeenCalledOnce()
  expect(sibling.set).toHaveBeenLastCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ range: expect.objectContaining({ endColumn: 8 }) })
    ])
  )
  first.refresh()
  sibling.refresh()
  vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS)
  expect(read).toHaveBeenCalledOnce()

  model.pushStackElement()
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: '[[second-link]]' }],
    () => null
  )
  model.pushStackElement()
  vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS)
  expect(read).toHaveBeenCalledTimes(2)
  for (const pane of [first, sibling]) {
    expect(pane.set).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ range: expect.objectContaining({ endColumn: 16 }) })
      ])
    )
  }
  first.dispose()
  first.set.mockClear()
  model.undo()
  vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS)
  expect(read).toHaveBeenCalledTimes(3)
  expect(first.set).not.toHaveBeenCalled()
  expect(sibling.set).toHaveBeenLastCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ range: expect.objectContaining({ endColumn: 8 }) })
    ])
  )
  sibling.dispose()
  read.mockClear()
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: '[[after-close]]' }],
    () => null
  )
  vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS)
  expect(read).not.toHaveBeenCalled()
  expect(first.disposeSubscription).toHaveBeenCalledOnce()
  expect(sibling.disposeSubscription).toHaveBeenCalledOnce()
  controllers.length = 0
  createPane(model)
  expect(read).toHaveBeenCalledOnce()
})

it('separates distinct models with the same version and refreshes after a model swap', () => {
  vi.useFakeTimers()
  const first = monaco.editor.createModel('[[one]]')
  const second = monaco.editor.createModel('plain')
  expect(first.getVersionId()).toBe(second.getVersionId())
  const firstRead = vi.spyOn(first, 'getValue')
  const secondRead = vi.spyOn(second, 'getValue')
  const pane = createPane(first)
  const other = createPane(second)
  expect(firstRead).toHaveBeenCalledOnce()
  expect(secondRead).toHaveBeenCalledOnce()
  expect(other.set).toHaveBeenLastCalledWith([])
  pane.swapModel(second)
  vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS)
  expect(pane.set).toHaveBeenLastCalledWith([])
  expect(firstRead).toHaveBeenCalledOnce()
  expect(secondRead).toHaveBeenCalledOnce()
})
