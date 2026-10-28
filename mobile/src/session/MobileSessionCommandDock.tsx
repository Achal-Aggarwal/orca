import { getVisibleTerminalAccessoryKeys } from '../terminal/terminal-accessory-layout'
import { useTerminalKeyRailToolbar } from './use-terminal-key-rail-toolbar'
import { View, Text, ScrollView, TextInput, Pressable } from 'react-native'
import { hostOs } from '../platform/host-os'
import { useShellSideRail, useDirectionPadAvailable } from '../layout/use-shell-side-rail'
import {
  ArrowUp,
  ChevronDown,
  ChevronsRight,
  Keyboard as KeyboardIcon,
  Monitor,
  Plus,
  Smartphone
} from 'lucide-react-native'
import { triggerMediumImpact } from '../platform/haptics'
import { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS } from '../terminal/terminal-key-definitions'
import { useShellTerminalKeyRail } from './shell-terminal-key-rail'
import { getTerminalCommandKeyboardType } from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputRow } from './MobileTerminalLiveInputRow'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { keepHeldPressThroughLongPress } from './held-press-long-press'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { styles } from './mobile-session-styles'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionCommandDock({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const {
    insets,
    bufferedTerminalDraftState,
    autocompleteEnabled,
    activeHandle,
    customKeys,
    setShowCustomKeyModal,
    setDeleteKeyTarget,
    visibleBuiltInAccessoryKeys,
    directionPadEnabled,
    terminalModes,
    canPaste,
    dictationMode,
    dictationEnabled,
    bindCommandField,
    canSend,
    canCompose,
    liveInputEnabled,
    showNativeChat,
    dictation,
    cancelDictation,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    toggleDisplayMode,
    handleSend,
    handleAccessoryKey,
    dismissSoftwareKeyboard,
    toggleLiveInput,
    stopAccessoryRepeat,
    startAccessoryRepeat,
    handlePaste,
    isAttaching,
    attachImage,
    activeMarkdownTab,
    activeFileTab,
    activeBrowserTab,
    keyboardHeight,
    keyboardLift
  } = controller
  const [sideRail, padAvailable] = [useShellSideRail(), useDirectionPadAvailable()]
  const accessoryBarKeepsKeyboard = useKeyboardPersistingTaps('always')
  const dockShown = !activeMarkdownTab && !activeFileTab && !activeBrowserTab && !showNativeChat
  const railShown = dockShown && !controller.showCustomKeyModal && !controller.deleteKeyTarget
  const keyboardVisible = keyboardHeight > 0 || keyboardLift > 0
  const phoneDisplayMode = isTerminalPhoneDisplayMode(activeHandle, terminalModes)
  const { toolbar, visibleCustomKeys } = useTerminalKeyRailToolbar({
    canSend,
    canCompose,
    canPaste,
    keyboardVisible,
    liveInputEnabled,
    phoneDisplayMode,
    customKeys,
    visibleBuiltInAccessoryKeys,
    directionPadEnabled
  })
  // The native host acknowledges all controls before the bottom row gives up its space.
  const railKeys: readonly string[] = useShellTerminalKeyRail(
    railShown,
    (id) => {
      if (!railShown || controller.activeHandleRef.current !== controller.activeHandle) {
        return
      }
      if (id === 'toggleKeyboard') {
        if (keyboardVisible) {
          dismissSoftwareKeyboard()
        } else if (liveInputEnabled && canSend) {
          controller.focusLiveInput()
        } else if (!liveInputEnabled && canCompose) {
          controller.commandInputRef.current?.focus()
        }
        return
      }
      if (id === 'toggleDisplayMode') {
        if (canSend && activeHandle) {
          void toggleDisplayMode(activeHandle)
        }
        return
      }
      if (id === 'toggleInputMode') {
        if (canCompose) {
          toggleLiveInput()
        }
        return
      }
      if (id === 'addCustomKey') {
        setShowCustomKeyModal(true)
        return
      }
      if (id.startsWith('custom:') || id.startsWith('deleteCustom:')) {
        const key = visibleCustomKeys.find((key) => key.id === id.slice(id.indexOf(':') + 1))
        if (key && canSend) {
          if (id.startsWith('deleteCustom:')) {
            triggerMediumImpact()
            setDeleteKeyTarget(key)
          } else {
            void handleAccessoryKey({ bytes: key.bytes })
          }
        }
        return
      }
      if (id === 'paste') {
        if (canSend) {
          void handlePaste()
        }
        return
      }
      const key = TERMINAL_ACCESSORY_KEY_DEFINITIONS.find((definition) => definition.id === id)
      if (key && canSend) {
        void handleAccessoryKey(createTerminalLiveAccessoryInput(key))
      }
    },
    controller.activeHandle,
    toolbar
  )
  const dockBuiltInKeys = getVisibleTerminalAccessoryKeys(
    toolbar.visibleBuiltInIds ?? [],
    !sideRail && padAvailable && directionPadEnabled !== false
  ).filter((key) => !railKeys.includes(key.id))
  return (
    dockShown && (
      <View
        style={[
          styles.commandDock,
          {
            paddingBottom: sideRail || padAvailable ? 0 : insets.bottom,
            transform: [{ translateY: -keyboardLift }]
          }
        ]}
      >
        {!railKeys.includes('toggleKeyboard') && (
          <View ref={accessoryBarKeepsKeyboard} style={styles.accessoryBar}>
            {/* Why: fixed keyboard escape hatch; outside ScrollView + shortcut path so it can't scroll away or be hidden (#5106). */}
            {(keyboardHeight > 0 || keyboardLift > 0) && (
              <Pressable
                style={({ pressed }) => [
                  styles.keyboardDismissKey,
                  pressed && styles.accessoryKeyPressed
                ]}
                onPress={dismissSoftwareKeyboard}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Dismiss keyboard"
                accessibilityHint="Hides the software keyboard and keeps the current terminal session open."
              >
                <View style={styles.keyboardDismissGlyph}>
                  <KeyboardIcon size={15} color={colors.textSecondary} strokeWidth={2} />
                  <ChevronDown
                    size={10}
                    color={colors.textSecondary}
                    strokeWidth={2.5}
                    style={styles.keyboardDismissChevron}
                  />
                </View>
              </Pressable>
            )}
            {/* Why: default tap handling makes the first accessory-key tap dismiss the keyboard and get swallowed (#5106). */}
            <ScrollView
              style={styles.accessoryScroll}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.accessoryContent}
              keyboardShouldPersistTaps="always"
            >
              <Pressable
                style={({ pressed }) => [
                  styles.accessoryKey,
                  pressed && styles.accessoryKeyPressed,
                  !canSend && styles.accessoryKeyDisabled
                ]}
                disabled={!canSend}
                onPress={() => {
                  if (activeHandle) {
                    void toggleDisplayMode(activeHandle)
                  }
                }}
                accessibilityLabel={
                  isTerminalPhoneDisplayMode(activeHandle, terminalModes)
                    ? 'Switch to desktop mode'
                    : 'Switch to phone mode'
                }
              >
                {isTerminalPhoneDisplayMode(activeHandle, terminalModes) ? (
                  <Monitor size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
                ) : (
                  <Smartphone size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.accessoryKey,
                  liveInputEnabled && styles.accessoryKeyActive,
                  pressed && styles.accessoryKeyPressed,
                  !canCompose && styles.accessoryKeyDisabled
                ]}
                // Why: offline, live mode is dead but the buffered box still composes — keep the escape hatch tappable (#6713).
                disabled={!canCompose}
                onPress={toggleLiveInput}
                accessibilityLabel={
                  liveInputEnabled
                    ? 'Switch to buffered command input'
                    : 'Switch to live terminal input'
                }
              >
                <ChevronsRight
                  size={14}
                  color={
                    liveInputEnabled
                      ? colors.bgBase
                      : canCompose
                        ? colors.textSecondary
                        : colors.textMuted
                  }
                />
              </Pressable>
              {canPaste && !railKeys.includes('paste') && (
                <Pressable
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    pressed && styles.accessoryKeyPressed,
                    !canSend && styles.accessoryKeyDisabled
                  ]}
                  disabled={!canSend}
                  onPress={() => void handlePaste()}
                  accessibilityLabel="Paste from clipboard"
                >
                  <Text
                    style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}
                  >
                    Paste
                  </Text>
                </Pressable>
              )}
              {dockBuiltInKeys.map((key) => (
                <Pressable
                  key={key.id}
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    pressed && styles.accessoryKeyPressed,
                    !canSend && styles.accessoryKeyDisabled
                  ]}
                  disabled={!canSend}
                  onPressIn={() => {
                    if (!key.repeatable) {
                      return
                    }
                    const input = createTerminalLiveAccessoryInput(key)
                    void handleAccessoryKey(input)
                    startAccessoryRepeat(input)
                  }}
                  onPressOut={() => {
                    if (key.repeatable) {
                      stopAccessoryRepeat()
                    }
                  }}
                  onPress={() => {
                    if (key.repeatable) {
                      return
                    }
                    void handleAccessoryKey(createTerminalLiveAccessoryInput(key))
                  }}
                  onLongPress={key.repeatable ? keepHeldPressThroughLongPress : undefined}
                  accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
                >
                  <Text
                    style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}
                  >
                    {key.label}
                  </Text>
                </Pressable>
              ))}
              {visibleCustomKeys.map((key) => (
                <Pressable
                  key={key.id}
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    styles.customAccessoryKey,
                    pressed && styles.accessoryKeyPressed,
                    !canSend && styles.accessoryKeyDisabled
                  ]}
                  disabled={!canSend}
                  onPress={() => void handleAccessoryKey({ bytes: key.bytes })}
                  onLongPress={() => {
                    triggerMediumImpact()
                    setDeleteKeyTarget(key)
                  }}
                  delayLongPress={400}
                  accessibilityLabel={`Send ${key.label}`}
                >
                  <Text
                    style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}
                  >
                    {key.label}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                style={({ pressed }) => [
                  styles.accessoryKey,
                  pressed && styles.accessoryKeyPressed
                ]}
                onPress={() => setShowCustomKeyModal(true)}
                accessibilityLabel="Add custom shortcut"
              >
                <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
              </Pressable>
            </ScrollView>
          </View>
        )}

        {liveInputEnabled ? (
          <MobileTerminalLiveInputRow controller={controller} compact={sideRail || padAvailable} />
        ) : (
          <View style={[styles.inputBar, (sideRail || padAvailable) && styles.compactInputBar]}>
            <TextInput
              ref={bindCommandField}
              // Why: Android caches IME inputType at mount, so toggling autocomplete must remount there; iOS updates in place.
              key={
                hostOs() === 'android'
                  ? autocompleteEnabled
                    ? 'cmd-input-ac-on'
                    : 'cmd-input-ac-off'
                  : 'cmd-input'
              }
              style={styles.textInput}
              value={bufferedTerminalDraftState.input}
              // Why: iOS kills active dictation/IME if JS writes a value differing from native text; store raw, normalize at send.
              onChangeText={bufferedTerminalDraftState.setInput}
              placeholder="Type a command…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={autocompleteEnabled}
              spellCheck={autocompleteEnabled}
              smartInsertDelete={false}
              // Why: not autofill content, but keyboard must stay default so non-Latin IMEs remain selectable.
              autoComplete="off"
              keyboardType={getTerminalCommandKeyboardType(hostOs(), autocompleteEnabled)}
              returnKeyType="send"
              blurOnSubmit={false}
              // Why: composing is local — an outage must not lock the field or discard typed text (#6713).
              editable={canCompose}
              onSubmitEditing={() => void handleSend()}
            />
            <MobileTerminalInputActions
              canSend={canSend}
              isAttaching={isAttaching}
              dictation={dictation}
              dictationMode={dictationMode}
              dictationEnabled={dictationEnabled}
              buttonStyle={styles.dictationButton}
              activeButtonStyle={styles.dictationButtonActive}
              disabledButtonStyle={styles.sendButtonDisabled}
              onAttachImage={() => void attachImage('library')}
              onAttachFile={() => void attachImage('files')}
              onDictationToggle={handleDictationToggle}
              onDictationPressIn={handleDictationPressIn}
              onDictationPressOut={handleDictationPressOut}
              onDictationCancel={cancelDictation}
            />
            <Pressable
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              disabled={!canSend}
              onPress={() => void handleSend()}
              accessibilityLabel="Send command"
            >
              <ArrowUp size={18} color={colors.textSecondary} strokeWidth={2.5} />
            </Pressable>
          </View>
        )}
      </View>
    )
  )
}
