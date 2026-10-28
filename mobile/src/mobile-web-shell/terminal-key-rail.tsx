import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { AppState, Pressable, ScrollView, Text, View } from 'react-native'
import {
  Keyboard,
  ChevronDown,
  Monitor,
  Smartphone,
  ChevronsRight,
  Plus
} from 'lucide-react-native'
import { hasTerminalDirectionPadSpace } from '../layout/side-rail-strip'
import {
  useSideRailContent,
  useSideRailStrip,
  useSideRailDirectionPadAvailable
} from '../layout/side-rail'
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS } from '../terminal/terminal-key-definitions'
import {
  createTerminalAccessoryRepeatController,
  TERMINAL_ACCESSORY_REPEAT_DELAY_MS,
  TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS
} from '../terminal/terminal-accessory-repeat'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { TerminalDirectionPad, type TerminalDirectionPadHandle } from './terminal-direction-pad'
import {
  sameTerminalKeyRailToolbar,
  BRIDGE_TERMINAL_KEY_IDS,
  BRIDGE_TERMINAL_TOOLBAR_KEY_IDS,
  type BridgeTerminalToolbar,
  BRIDGE_TERMINAL_KEY_RAIL_GRANT,
  type BridgeTerminalKeyId,
  type BridgeTerminalKeyRail
} from './bridge/bridge-terminal-key'

const KEY_HEIGHT = 40

const PASTE_KEY = {
  label: 'Paste',
  accessibilityLabel: 'Paste from clipboard',
  repeatable: false
}

const RAIL_KEYS = BRIDGE_TERMINAL_KEY_IDS.flatMap((id) => {
  const key =
    id === 'paste'
      ? PASTE_KEY
      : TERMINAL_ACCESSORY_KEY_DEFINITIONS.find((definition) => definition.id === id)
  return key ? [{ ...key, id }] : []
})

function selectedRailKeys(toolbar?: BridgeTerminalToolbar) {
  if (!toolbar?.visibleBuiltInIds) {
    return RAIL_KEYS
  }
  const selected = new Set(toolbar.visibleBuiltInIds)
  return toolbar.visibleBuiltInIds
    .flatMap((id) => {
      const key = RAIL_KEYS.find((key) => key.id === id && key.id !== 'paste')
      if (!key || !selected.delete(id)) {
        return []
      }
      return [key]
    })
    .concat(RAIL_KEYS.filter((key) => key.id === 'paste'))
}

/** Every key remains reachable by scrolling, regardless of the strip's height. */
export function terminalKeyRailKeys(
  height: number,
  toolbar?: BridgeTerminalToolbar
): BridgeTerminalKeyRail {
  if (height <= 0) {
    return []
  }
  return [
    ...selectedRailKeys(toolbar).map((key) => key.id),
    ...(toolbar ? BRIDGE_TERMINAL_TOOLBAR_KEY_IDS : []),
    ...(toolbar?.customKeys.flatMap((key) => [
      `custom:${key.id}` as const,
      `deleteCustom:${key.id}` as const
    ]) ?? [])
  ]
}

/**
 * The page's terminal keys stood on end in a side inset strip, for a window that has one: the
 * iPhone Duo's status column leaves the rest of its strip empty. Each press goes to the page, which
 * sends it as its own accessory key would; arrows and deletes repeat while held, as there.
 */
export function TerminalKeyRail({
  keys,
  onKey,
  toolbar,
  inputOwner
}: {
  keys: BridgeTerminalKeyRail
  onKey: (key: BridgeTerminalKeyId) => boolean
  toolbar?: BridgeTerminalToolbar
  inputOwner?: string | null
}) {
  useMobileColorScheme()
  const [repeat] = useState(() => createTerminalAccessoryRepeatController<BridgeTerminalKeyId>())
  const padRef = useRef<TerminalDirectionPadHandle | null>(null)
  const strip = useSideRailStrip()
  const padAvailable = useSideRailDirectionPadAvailable()
  const pinPad = hasTerminalDirectionPadSpace(strip)
  const showPad =
    strip !== null && padAvailable && toolbar !== undefined && toolbar.directionPadEnabled !== false
  const gesture = useRef({ x: 0, y: 0, cancelled: false, repeated: false })
  const cancelGesture = useCallback(() => {
    gesture.current.cancelled = true
    repeat.cancel()
    padRef.current?.cancel()
  }, [repeat])
  useLayoutEffect(cancelGesture, [cancelGesture, inputOwner])
  useEffect(() => cancelGesture, [cancelGesture, keys, showPad, pinPad])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        cancelGesture()
      }
    })
    return () => subscription.remove()
  }, [cancelGesture])
  const send = (key: BridgeTerminalKeyId) => Promise.resolve(onKey(key))
  const renderedKeys: {
    id: BridgeTerminalKeyId
    label: string
    accessibilityLabel?: string
    repeatable?: boolean
    disabled?: boolean
    active?: boolean
    deleteId?: BridgeTerminalKeyId
  }[] = [
    ...(toolbar
      ? [
          {
            id: 'toggleKeyboard' as const,
            label: 'Keyboard',
            accessibilityLabel: toolbar.keyboardVisible ? 'Dismiss keyboard' : 'Show keyboard',
            disabled:
              !toolbar.keyboardVisible &&
              !(toolbar.liveInputEnabled ? toolbar.canSend : toolbar.canCompose)
          },
          {
            id: 'toggleDisplayMode' as const,
            label: 'Display',
            accessibilityLabel: toolbar.phoneDisplayMode
              ? 'Switch to desktop mode'
              : 'Switch to phone mode',
            disabled: !toolbar.canSend
          },
          {
            id: 'toggleInputMode' as const,
            label: 'Input',
            accessibilityLabel: toolbar.liveInputEnabled
              ? 'Switch to buffered command input'
              : 'Switch to live terminal input',
            disabled: !toolbar.canCompose,
            active: toolbar.liveInputEnabled
          }
        ]
      : []),
    ...selectedRailKeys(toolbar)
      .filter((key) => key.id !== 'paste' || !toolbar || toolbar.canPaste)
      .map((key) => ({
        ...key,
        disabled: toolbar ? !toolbar.canSend : false
      })),
    ...(toolbar?.customKeys.map((key) => ({
      id: `custom:${key.id}` as const,
      deleteId: `deleteCustom:${key.id}` as const,
      label: key.label,
      disabled: !toolbar.canSend
    })) ?? []),
    ...(toolbar
      ? [{ id: 'addCustomKey' as const, label: '+', accessibilityLabel: 'Add custom shortcut' }]
      : [])
  ]
  const pad =
    showPad && strip && toolbar ? (
      <TerminalDirectionPad
        ref={padRef}
        enabled={toolbar.canSend}
        width={Math.min(68, strip.width - spacing.sm * 2)}
        onKey={onKey}
        onInteractionStart={cancelGesture}
      />
    ) : null
  return (
    <View style={styles.viewport}>
      <ScrollView
        style={styles.viewport}
        contentContainerStyle={styles.rail}
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="none"
        onScrollBeginDrag={cancelGesture}
        onTouchCancel={cancelGesture}
        onTouchMove={(event) => {
          const { pageX, pageY } = event.nativeEvent
          if (
            !gesture.current.cancelled &&
            Math.hypot(pageX - gesture.current.x, pageY - gesture.current.y) > 8
          ) {
            cancelGesture()
          }
        }}
      >
        {!pinPad && pad}
        {renderedKeys
          .filter((key) => keys.includes(key.id))
          .map((key) => (
            <Pressable
              key={key.id}
              style={({ pressed }) => [
                styles.key,
                key.active && styles.keyActive,
                pressed && styles.keyPressed,
                key.disabled && styles.keyDisabled
              ]}
              disabled={key.disabled}
              onPressIn={(event) => {
                repeat.cancel()
                padRef.current?.cancel()
                gesture.current = {
                  x: event.nativeEvent.pageX,
                  y: event.nativeEvent.pageY,
                  cancelled: false,
                  repeated: false
                }
              }}
              delayLongPress={TERMINAL_ACCESSORY_REPEAT_DELAY_MS}
              onLongPress={
                key.repeatable || key.deleteId
                  ? () => {
                      if (!gesture.current.cancelled) {
                        gesture.current.repeated = true
                        if (key.deleteId) {
                          onKey(key.deleteId)
                        } else {
                          repeat.start(key.id, send, TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS)
                        }
                      }
                    }
                  : undefined
              }
              onPressOut={() => {
                if (key.repeatable) {
                  repeat.stop()
                }
              }}
              onPress={() => {
                if (!gesture.current.cancelled && !gesture.current.repeated) {
                  onKey(key.id)
                }
              }}
              accessibilityRole="button"
              accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
            >
              {key.id === 'toggleKeyboard' ? (
                <View style={styles.keyboardGlyph}>
                  <Keyboard size={16} color={colors.textSecondary} />
                  {toolbar?.keyboardVisible && (
                    <ChevronDown size={10} color={colors.textSecondary} />
                  )}
                </View>
              ) : key.id === 'toggleDisplayMode' ? (
                toolbar?.phoneDisplayMode ? (
                  <Monitor size={16} color={colors.textSecondary} />
                ) : (
                  <Smartphone size={16} color={colors.textSecondary} />
                )
              ) : key.id === 'toggleInputMode' ? (
                <ChevronsRight
                  size={16}
                  color={key.active ? colors.bgBase : colors.textSecondary}
                />
              ) : key.id === 'addCustomKey' ? (
                <Plus size={16} color={colors.textSecondary} />
              ) : (
                <Text style={styles.keyText} numberOfLines={1} adjustsFontSizeToFit>
                  {key.label}
                </Text>
              )}
            </Pressable>
          ))}
      </ScrollView>
      {pinPad && pad}
    </View>
  )
}

const NO_RAIL_KEYS: BridgeTerminalKeyRail = []

/**
 * The keys this shell screen's scrollable rail shows: when the window has one, the
 * page is open on the focused screen, was granted the rail, which only a session route is, and
 * claims it, which it does only while a terminal and its key row are on screen. Empty otherwise.
 */
export function useShellKeyRail(args: {
  /** The session on screen, or null while none is ready. A claim belongs to the one that made it. */
  sessionId: string | null
  overlay: boolean
  routeGrants: readonly string[]
}): {
  keys: BridgeTerminalKeyRail
  inputOwner: string | undefined
  toolbar: BridgeTerminalToolbar | undefined
  reportClaim: (claimed: boolean, inputOwner?: string, toolbar?: BridgeTerminalToolbar) => void
} {
  const { sessionId } = args
  const height = useSideRailStrip()?.height ?? null
  const [claim, setClaim] = useState<{
    sessionId: string | null
    inputOwner?: string
    toolbar?: BridgeTerminalToolbar
  } | null>(null)
  // Focus rather than mount: the stack keeps this screen mounted under whatever is pushed over it.
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const took =
    sessionId !== null &&
    claim?.sessionId === sessionId &&
    focused &&
    !args.overlay &&
    args.routeGrants.includes(BRIDGE_TERMINAL_KEY_RAIL_GRANT)
  const keys = useMemo(
    () => (took && height !== null ? terminalKeyRailKeys(height, claim?.toolbar) : NO_RAIL_KEYS),
    [took, height, claim?.toolbar]
  )
  const reportClaim = useCallback(
    (claimed: boolean, inputOwner?: string, toolbar?: BridgeTerminalToolbar) =>
      setClaim((previous) => {
        if (!claimed) {
          return null
        }
        // Equivalent init reassertions must not cancel a key already held on the rail.
        return previous?.sessionId === sessionId &&
          previous.inputOwner === inputOwner &&
          sameTerminalKeyRailToolbar(previous.toolbar, toolbar)
          ? previous
          : { sessionId, inputOwner, toolbar }
      }),
    [sessionId]
  )
  return { keys, inputOwner: claim?.inputOwner, toolbar: claim?.toolbar, reportClaim }
}

/** Draws the rail and tells the page which keys it holds, so the page drops just those. */
export function usePublishedShellKeyRail(
  keys: BridgeTerminalKeyRail,
  bridge: {
    publishTerminalKeyRail: (keys: BridgeTerminalKeyRail) => void
    sendTerminalKey: (key: BridgeTerminalKeyId, inputOwner?: string) => boolean
  },
  inputOwner?: string,
  toolbar?: BridgeTerminalToolbar
): void {
  const { publishTerminalKeyRail } = bridge
  useEffect(() => {
    publishTerminalKeyRail(keys)
  }, [publishTerminalKeyRail, keys])
  // Held, so a new bridge identity does not rebuild the node, which would show the rail again.
  const sendRef = useRef(bridge.sendTerminalKey)
  useLayoutEffect(() => {
    sendRef.current = bridge.sendTerminalKey
  }, [bridge.sendTerminalKey])
  const node = useMemo(
    () =>
      keys.length > 0 ? (
        <TerminalKeyRail
          inputOwner={inputOwner}
          keys={keys}
          toolbar={toolbar}
          onKey={(key) => sendRef.current(key, inputOwner)}
        />
      ) : null,
    [keys, inputOwner, toolbar]
  )
  useSideRailContent(node)
}

const styles = themedStyleSheet(() => ({
  viewport: {
    flex: 1
  },
  rail: {
    alignItems: 'stretch',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  key: {
    height: KEY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  keyActive: { backgroundColor: colors.textPrimary },
  keyDisabled: { opacity: 0.45 },
  keyboardGlyph: { alignItems: 'center' },
  keyPressed: {
    backgroundColor: colors.borderSubtle
  },
  keyText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  }
}))
