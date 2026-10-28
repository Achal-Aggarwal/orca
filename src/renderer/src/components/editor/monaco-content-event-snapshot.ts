import type { editor } from 'monaco-editor'

const contentEventSnapshots = new WeakMap<editor.ITextModel, { version: number; value: string }>()

export function readContentEventSnapshot(
  model: editor.ITextModel,
  mountedEditor: editor.IStandaloneCodeEditor
): string {
  const version = model.getVersionId()
  const previous = contentEventSnapshots.get(model)
  if (previous) {
    if (previous.version !== version) {
      previous.version = version
      previous.value = mountedEditor.getValue()
    }
    return previous.value
  }
  const snapshot = { version, value: mountedEditor.getValue() }
  contentEventSnapshots.set(model, snapshot)
  // Share synchronous pane delivery, then release the full text even while the model stays mounted.
  queueMicrotask(() => {
    if (contentEventSnapshots.get(model) === snapshot) {
      contentEventSnapshots.delete(model)
    }
  })
  return snapshot.value
}
