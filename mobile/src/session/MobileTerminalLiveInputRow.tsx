import { View, Pressable, TextInput } from 'react-native'
import { Keyboard as KeyboardIcon } from 'lucide-react-native'
import { hostOs } from '../platform/host-os'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import { getTerminalLiveInputKeyboardType } from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileTerminalLiveInputRow({
  controller,
  compact = false
}: {
  controller: MobileSessionController
  compact?: boolean
}) {
  const {
    canSend,
    focusLiveInput,
    dismissSoftwareKeyboard,
    keyboardHeight,
    keyboardLift,
    dictation,
    isAttaching,
    liveInputCapture,
    dictationMode,
    dictationEnabled,
    attachImage,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    cancelDictation,
    bindLiveInputField,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    submitLiveInput
  } = controller
  const rowKeepsKeyboard = useKeyboardPersistingTaps('always')
  const keyboardVisible = keyboardHeight > 0 || keyboardLift > 0
  return (
    <View
      ref={rowKeepsKeyboard}
      style={[styles.inputBar, compact && styles.compactInputBar, styles.liveInputBar]}
    >
      <Pressable
        style={({ pressed }) => [
          styles.liveInputFocusTarget,
          pressed && styles.liveInputFocusTargetPressed,
          !canSend && !keyboardVisible && styles.liveInputFocusTargetDisabled
        ]}
        disabled={!canSend && !keyboardVisible}
        onPress={keyboardVisible ? dismissSoftwareKeyboard : focusLiveInput}
        accessibilityRole="button"
        accessibilityLabel={
          keyboardVisible
            ? 'Hide keyboard for live terminal input'
            : 'Show keyboard for live terminal input'
        }
        accessibilityHint={
          keyboardVisible
            ? 'Hides the software keyboard and keeps the current terminal session open'
            : 'Typed text is sent directly to the active terminal'
        }
      >
        <KeyboardIcon size={16} color={colors.textSecondary} strokeWidth={2} />
        <MobileTerminalLiveInputStatus
          dictation={dictation}
          isAttaching={isAttaching}
          liveInputText={liveInputCapture}
          keyboardVisible={keyboardVisible}
        />
      </Pressable>
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
      <TextInput
        ref={bindLiveInputField}
        style={styles.liveInputCapture}
        value={liveInputCapture}
        onChange={handleLiveInputChange}
        onKeyPress={handleLiveInputKeyPress}
        onSubmitEditing={submitLiveInput}
        placeholder=""
        showSoftInputOnFocus
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        smartInsertDelete={false}
        // Why: iOS textContentType overrides autoComplete and can narrow the keyboard; keep IME switching available.
        autoComplete="off"
        keyboardType={getTerminalLiveInputKeyboardType(hostOs())}
        returnKeyType="default"
        blurOnSubmit={false}
        editable={canSend}
        importantForAutofill="no"
      />
    </View>
  )
}
