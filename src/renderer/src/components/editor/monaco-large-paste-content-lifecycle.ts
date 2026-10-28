import type { editor } from 'monaco-editor'
import { beginEditorLargePaste } from './editor-large-paste-in-flight'
import { registerMonacoLargePasteLifecycle } from './monaco-large-paste-lifecycle'
import type { MonacoPasteEditor } from './monaco-large-text-paste'

type ContentPublisher = (content: string, model: editor.ITextModel) => void
type PendingPaste = {
  count: number
  changed: boolean
  publishers: Map<object, ContentPublisher>
}

const pendingPastes = new WeakMap<editor.ITextModel, PendingPaste>()

export function installMonacoLargePasteContentLifecycle(
  instance: MonacoPasteEditor,
  getPublisher: () => ContentPublisher | undefined
): { deferContentEvent: () => boolean; dispose: () => void } {
  const owner = {}
  const capturePublisher = (pending: PendingPaste): void => {
    if (!pending.publishers.has(owner)) {
      const publish = getPublisher()
      if (publish) {
        pending.publishers.set(owner, publish)
      }
    }
  }
  const unregister = registerMonacoLargePasteLifecycle(instance, () => {
    const model = instance.getModel()
    if (!model) {
      return () => {}
    }
    const pending = pendingPastes.get(model) ?? {
      count: 0,
      changed: false,
      publishers: new Map<object, ContentPublisher>()
    }
    pendingPastes.set(model, pending)
    pending.count += 1
    capturePublisher(pending)
    const endSaveDeferral = beginEditorLargePaste(model.uri.toString())
    let finished = false
    return (result) => {
      if (finished) {
        return
      }
      finished = true
      endSaveDeferral()
      pending.changed ||= result.status === 'pasted' || result.status === 'cancelled'
      pending.count -= 1
      if (pending.count > 0) {
        return
      }
      pendingPastes.delete(model)
      if (pending.changed && !model.isDisposed() && pending.publishers.size > 0) {
        const content = model.getValue()
        pending.publishers.forEach((publish) => publish(content, model))
      }
      pending.publishers.clear()
    }
  })
  return {
    deferContentEvent: () => {
      const model = instance.getModel()
      const pending = model && pendingPastes.get(model)
      if (!pending) {
        return false
      }
      capturePublisher(pending)
      return true
    },
    dispose: unregister
  }
}
