import type { editor, ISelection } from 'monaco-editor'

// Twenty entries covers typical recent files.
const CACHE_MAX_ENTRIES = 20

/** Evict the oldest eligible entry after a write; protected owners may keep a cache above its limit. */
export function setWithLRU<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number = CACHE_MAX_ENTRIES,
  canEvict?: (value: V, key: K) => boolean
): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > maxEntries) {
    evictOldestLRUEntry(map, canEvict)
  }
}

export function evictOldestLRUEntry<K, V>(
  map: Map<K, V>,
  canEvict?: (value: V, key: K) => boolean
): boolean {
  for (const [key, value] of map) {
    if (!canEvict || canEvict(value, key)) {
      map.delete(key)
      return true
    }
  }
  return false
}

// Module maps preserve positions across remount without broadcasting store updates on every scroll.
export const scrollTopCache = new Map<string, number>()

// Keep cursor/selection changes outside Zustand for the same no-rerender reason.
export const editorSelectionCache = new Map<string, readonly ISelection[]>()

// Store pdf.js user-space locations; pixel offsets drift when pane width/zoom rebuilds page layout.
export type PdfViewPosition = { pageNumber: number; top: number; left: number }
export const pdfViewPositionCache = new Map<string, PdfViewPosition>()

// Persist playback seconds across media-tab unmounts so return does not restart the clip.
export const mediaPlaybackPositionCache = new Map<string, number>()

// Monaco diff view state includes both cursors/selections and model state; preserve that context beyond numeric scrolling, as VS Code does.
export const diffViewStateCache = new Map<string, editor.IDiffEditorViewState>()
