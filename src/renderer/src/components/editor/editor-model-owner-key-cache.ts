import type { OpenFile } from '@/store/slices/editor'
import type { EditorBufferViewIndex } from '@/store/slices/editor/buffers/editor-buffer-views'
import {
  editorBufferRouteInputsEqual,
  type EditorBufferRouteState
} from '@/store/slices/editor/buffers/editor-buffer-identity-cache'
import { getEditorModelOwnerKey } from './editor-model-owner'

type OwnerKeyState = EditorBufferRouteState & Partial<EditorBufferViewIndex>

function ownerInputsEqual(a: OwnerKeyState, b: OwnerKeyState): boolean {
  return a.editorBufferIdOf === b.editorBufferIdOf && editorBufferRouteInputsEqual(a, b)
}

function cachedOwnerKey(
  keys: WeakMap<OpenFile, string>,
  file: OpenFile,
  state: OwnerKeyState
): string {
  let key = keys.get(file)
  if (key === undefined) {
    key = getEditorModelOwnerKey(file, state)
    keys.set(file, key)
  }
  return key
}

/** Keys stay valid until an owner input changes, so a tab edit re-resolves that tab, not every tab. */
export function createEditorModelOwnerKeyCache(initialState: OwnerKeyState) {
  // The last editor can close without another lookup; do not pin its whole store snapshot.
  let keyState = new WeakRef(initialState)
  let keys = new WeakMap<OpenFile, string>()
  const ownerKeyOf = (file: OpenFile, state: OwnerKeyState): string => {
    const previous = keyState.deref()
    if (state !== previous) {
      if (!previous || !ownerInputsEqual(state, previous)) {
        keys = new WeakMap()
      }
      keyState = new WeakRef(state)
    }
    return cachedOwnerKey(keys, file, state)
  }
  /** Resolver for `state` that never evicts the current keys, for reading a superseded state. */
  const ownerKeyReaderFor = (state: OwnerKeyState): ((file: OpenFile) => string) => {
    const previous = keyState.deref()
    const stateKeys =
      previous && ownerInputsEqual(state, previous) ? keys : new WeakMap<OpenFile, string>()
    return (file) => cachedOwnerKey(stateKeys, file, state)
  }
  return { ownerKeyOf, ownerKeyReaderFor, ownerInputsEqual }
}
