import type { editor } from 'monaco-editor'

const contentEventSnapshots = new WeakMap<editor.ITextModel, { version: number; value: string }>()

export function readContentEventSnapshot(
  model: editor.ITextModel,
  reader: { getValue: () => string }
): string {
  const version = model.getVersionId()
  const previous = contentEventSnapshots.get(model)
  if (previous) {
    if (previous.version !== version) {
      previous.version = version
      previous.value = reader.getValue()
    }
    return previous.value
  }
  const snapshot = { version, value: reader.getValue() }
  contentEventSnapshots.set(model, snapshot)
  // Share synchronous delivery/reconciliation, then release the full text while the model stays mounted.
  queueMicrotask(() => {
    if (contentEventSnapshots.get(model) === snapshot) {
      contentEventSnapshots.delete(model)
    }
  })
  return snapshot.value
}
