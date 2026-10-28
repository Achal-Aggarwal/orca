import { nativeChatPastedTextId } from './native-chat-pasted-text-reference'
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'
import { subscribeToNativeChatComposerDraft } from './native-chat-composer-draft-store'
import {
  loadNativeChatTerminalPasteSources,
  nativeChatPastedTextAdmission,
  nativeChatPastedTextState
} from './native-chat-composer-pasted-text-references'

const Scope = createContext('')
export const NativeChatPastedTextScopeProvider = Scope.Provider

export function useNativeChatPastedTextState(token: string): string | null {
  const scope = useContext(Scope)
  useTerminalSourceLoad(scope, nativeChatPastedTextId(token))
  const subscribe = useCallback(
    (changed: () => void) => subscribeToNativeChatComposerDraft(scope, changed),
    [scope]
  )
  return useSyncExternalStore(subscribe, () => nativeChatPastedTextState(scope, token))
}

export function useNativeChatPastedTextAdmission(scope: string) {
  useTerminalSourceLoad(scope)
  const subscribe = useCallback(
    (changed: () => void) => subscribeToNativeChatComposerDraft(scope, changed),
    [scope]
  )
  return useSyncExternalStore(subscribe, () => nativeChatPastedTextAdmission(scope))
}

function useTerminalSourceLoad(scope: string, id?: string | null): void {
  useEffect(() => {
    const load = () => {
      void loadNativeChatTerminalPasteSources(scope, id)
    }
    load()
    return subscribeToNativeChatComposerDraft(scope, load)
  }, [scope, id])
}
