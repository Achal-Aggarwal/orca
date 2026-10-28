import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'
import { editorDiscardEpoch, retainEditorDiscardEpoch } from './editor-discard-epoch'

type ViewEpochOwner = { recordId: string; owners: number; release: () => void }
const viewEpochOwners = new Map<string, ViewEpochOwner>()
let unsubscribeEpochOwners: (() => void) | undefined

export function retainStaleViewEditEpoch(fileId: string): () => void {
  let owner = viewEpochOwners.get(fileId)
  if (!owner) {
    const recordId = editorBufferIdOfView(useAppStore.getState(), fileId)
    owner = { recordId, owners: 0, release: retainEditorDiscardEpoch(recordId) }
    viewEpochOwners.set(fileId, owner)
  }
  owner.owners += 1
  unsubscribeEpochOwners ??= useAppStore.subscribe((state, previous) => {
    if (state.editorBufferIdOf === previous.editorBufferIdOf) {
      return
    }
    for (const [viewId, current] of viewEpochOwners) {
      const recordId = state.editorBufferIdOf[viewId]
      // Keep the closed view's epoch through its final layout flush.
      if (recordId === undefined || recordId === current.recordId) {
        continue
      }
      const release = retainEditorDiscardEpoch(recordId)
      current.release()
      current.recordId = recordId
      current.release = release
    }
  })
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    owner.owners -= 1
    if (owner.owners === 0) {
      owner.release()
      viewEpochOwners.delete(fileId)
    }
    if (viewEpochOwners.size === 0) {
      unsubscribeEpochOwners?.()
      unsubscribeEpochOwners = undefined
    }
  }
}

/** Snapshot when a delayed view edit starts; a Discard since then drops the edit silently. */
export function staleViewEditEpoch(fileId: string): number {
  return editorDiscardEpoch(
    viewEpochOwners.get(fileId)?.recordId ?? editorBufferIdOfView(useAppStore.getState(), fileId)
  )
}

/** Focus moved outside the view, e.g. into another view of the same file, so its delayed edit must commit now. */
export function focusLeftView(event: {
  currentTarget: Element
  relatedTarget: EventTarget | null
}): boolean {
  const next = event.relatedTarget
  return !(next instanceof Node && event.currentTarget.contains(next))
}

/** A delayed view edit was dropped because the shared text changed after the edit began. */
export function notifyStaleViewEditRejected(fileId: string, editEpoch: number): void {
  if (staleViewEditEpoch(fileId) !== editEpoch) {
    return
  }
  toast.error(
    translate(
      'auto.components.editor.staleViewEdit.rejected',
      'Recent typing in this view was discarded because the file changed in another view.'
    ),
    { id: 'editor-stale-view-edit' }
  )
}
