import { useMemo } from 'react'
import type { BridgeTerminalToolbar } from '../mobile-web-shell/bridge/bridge-terminal-key'
import type { CustomKey } from '../terminal/terminal-custom-keys'
import type { TerminalAccessoryKey } from '../terminal/terminal-accessory-keys'

export function useTerminalKeyRailToolbar({
  customKeys,
  visibleBuiltInAccessoryKeys,
  directionPadEnabled,
  canSend,
  canCompose,
  canPaste,
  keyboardVisible,
  liveInputEnabled,
  phoneDisplayMode
}: Omit<BridgeTerminalToolbar, 'customKeys' | 'visibleBuiltInIds'> & {
  customKeys: CustomKey[]
  visibleBuiltInAccessoryKeys: TerminalAccessoryKey[]
}) {
  const visibleCustomKeys = useMemo(
    () => customKeys.filter((key) => key.visible !== false),
    [customKeys]
  )
  const toolbar = useMemo(
    () => ({
      canSend,
      canCompose,
      canPaste,
      keyboardVisible,
      liveInputEnabled,
      phoneDisplayMode,
      directionPadEnabled,
      visibleBuiltInIds: visibleBuiltInAccessoryKeys.map((key) => key.id),
      customKeys: visibleCustomKeys.map(({ id, label }) => ({ id, label }))
    }),
    [
      canSend,
      canCompose,
      canPaste,
      keyboardVisible,
      liveInputEnabled,
      phoneDisplayMode,
      directionPadEnabled,
      visibleBuiltInAccessoryKeys,
      visibleCustomKeys
    ]
  )
  return { toolbar, visibleCustomKeys }
}
