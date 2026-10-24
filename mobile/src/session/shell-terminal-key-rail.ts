import type {
  BridgeTerminalToolbar,
  BridgeTerminalKeyId,
  BridgeTerminalKeyRail
} from '../mobile-web-shell/bridge/bridge-terminal-key'
import { createElement, useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useSideRailContent, useSideRailStrip } from '../layout/side-rail'
import { TerminalKeyRail, terminalKeyRailKeys } from '../mobile-web-shell/terminal-key-rail'

const NO_RAIL_KEYS: BridgeTerminalKeyRail = []

/**
 * The keys the shell's rail shows beside this screen, which then drops them from its own row;
 * `onKey` takes each press on it. Native sessions claim the same root rail directly.
 */
export function useShellTerminalKeyRail(
  shown: boolean,
  onKey: (key: BridgeTerminalKeyId) => void,
  focusedTerminal?: string | null,
  toolbar?: BridgeTerminalToolbar
): BridgeTerminalKeyRail {
  const strip = useSideRailStrip()
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const height = strip?.height ?? 0
  const keys = useMemo(
    () => (shown && focused && height > 0 ? terminalKeyRailKeys(height, toolbar) : NO_RAIL_KEYS),
    [shown, focused, height, toolbar]
  )
  useSideRailContent(
    keys.length
      ? createElement(TerminalKeyRail, {
          key: focusedTerminal,
          keys,
          toolbar,
          onKey: (key) => {
            onKey(key)
            return true
          }
        })
      : null
  )
  return keys
}
