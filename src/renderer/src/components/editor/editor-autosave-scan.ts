import type { OpenFile } from '@/store/slices/editor'
import type { AppStoreApi, EditorSaveKeys, EditorSaveQueue } from './editor-save-queue'
import type { acquireEditorFileOperation } from '@/lib/editor-file-operation-owner'
import type { AutoSaveHolds } from './editor-autosave-holds'
import {
  canAutoSaveOpenFile,
  isAutosaveSuspendedForFile,
  normalizeAutoSaveDelayMs
} from './editor-autosave'

export function createEditorAutoSaveScan(
  store: AppStoreApi,
  keys: EditorSaveKeys,
  holds: AutoSaveHolds,
  autoSaveTimers: Map<string, number>,
  autoSaveScheduledContent: Map<string, string>,
  clearScheduledAutoSave: (key: string) => void,
  captureSave: (file: OpenFile) => {
    operation?: ReturnType<typeof acquireEditorFileOperation>
    error?: unknown
  },
  queueSave: EditorSaveQueue['queueSave']
): () => void {
  return (): void => {
    const state = store.getState()
    holds.flagOverdue(state)
    const openFilesByKey = new Map(
      state.openFiles.map((file) => [keys.schedule(state, file.id), file])
    )

    for (const key of Array.from(autoSaveTimers.keys())) {
      const file = openFilesByKey.get(key)
      const draft = file ? state.editorDrafts[file.id] : undefined
      const shouldKeepTimer =
        state.settings?.editorAutoSave &&
        file &&
        file.isDirty &&
        canAutoSaveOpenFile(file) &&
        // Why: suspension holds until the user picks a side via the banner (or saves manually).
        !isAutosaveSuspendedForFile(file) &&
        !holds.isHeld(state, file) &&
        draft !== undefined
      if (!shouldKeepTimer) {
        clearScheduledAutoSave(key)
      }
    }

    if (!state.settings?.editorAutoSave) {
      return
    }

    const autoSaveDelayMs = normalizeAutoSaveDelayMs(state.settings.editorAutoSaveDelayMs)
    for (const file of state.openFiles) {
      const key = keys.schedule(state, file.id)
      const draft = state.editorDrafts[file.id]
      if (
        !file.isDirty ||
        draft === undefined ||
        !canAutoSaveOpenFile(file) ||
        isAutosaveSuspendedForFile(file) ||
        holds.isHeld(state, file)
      ) {
        clearScheduledAutoSave(key)
        continue
      }

      if (autoSaveTimers.has(key) && autoSaveScheduledContent.get(key) === draft) {
        continue
      }

      const acquisition = captureSave(file)

      clearScheduledAutoSave(key)
      autoSaveScheduledContent.set(key, draft)
      const timerId = window.setTimeout(() => {
        autoSaveTimers.delete(key)
        autoSaveScheduledContent.delete(key)
        if (!acquisition.operation) {
          console.error('[editor] autosave failed', acquisition.error)
          return
        }
        void queueSave(acquisition.operation.file, draft, 'autosave').catch((error) => {
          console.error('[editor] autosave failed', error)
        })
      }, autoSaveDelayMs)
      autoSaveTimers.set(key, timerId)
    }
  }
}
