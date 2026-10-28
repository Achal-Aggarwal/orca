// Keyed by buffer record. Dirty state can be republished after a discard, so saves compare this.
type DiscardEpoch = { epoch: number; owners: number }
const epochs = new Map<string, DiscardEpoch>()

export function editorDiscardEpoch(recordId: string): number {
  return epochs.get(recordId)?.epoch ?? 0
}

export function retainEditorDiscardEpoch(recordId: string): () => void {
  const entry = epochs.get(recordId) ?? { epoch: 0, owners: 0 }
  entry.owners += 1
  epochs.set(recordId, entry)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    entry.owners -= 1
    if (entry.owners === 0) {
      epochs.delete(recordId)
    }
  }
}

/** "Don't Save": every save requested before this writes nothing. */
export function bumpEditorDiscardEpoch(recordId: string): void {
  const entry = epochs.get(recordId)
  if (entry) {
    entry.epoch += 1
  }
}

/** Thrown before sending a save that a discard voided while it waited on the host. */
export class EditorSaveDiscardedError extends Error {
  constructor() {
    super('The edits were discarded before the save was sent.')
  }
}
