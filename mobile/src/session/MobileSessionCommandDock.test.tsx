import { createElement } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { BridgeTerminalToolbar } from '../mobile-web-shell/bridge/bridge-terminal-key'
import { getVisibleTerminalAccessoryKeys } from '../terminal/terminal-accessory-layout'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { MobileSessionController } from './use-mobile-session-controller'

const input = vi.hoisted(() => ({ focus: vi.fn() }))
const keepKeyboard = vi.hoisted(() => vi.fn())
const shellLayout = vi.hoisted(
  (): {
    padAvailable?: boolean
    sideRail: boolean
    keys: string[]
    toolbar?: BridgeTerminalToolbar
    onKey: (key: string) => void
  } => ({
    sideRail: false,
    keys: [],
    onKey: (_key: string) => {}
  })
)
vi.mock('../layout/use-shell-side-rail', () => ({
  useShellSideRail: () => shellLayout.sideRail,
  useDirectionPadAvailable: () => shellLayout.padAvailable === true
}))
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'ios', select: (values: { ios?: unknown }) => values.ios },
    TextInput: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => input, [])
      return React.createElement('TextInput', props)
    }),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFillObject: {} }
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  ChevronsRight: 'ChevronsRight',
  Keyboard: 'KeyboardIcon',
  Monitor: 'Monitor',
  Plus: 'Plus',
  Smartphone: 'Smartphone',
  ImagePlus: 'ImagePlus',
  Mic: 'Mic'
}))
vi.mock('../platform/host-os', () => ({ hostOs: () => 'ios' }))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('../platform/keyboard-persisting-taps', () => ({
  useKeyboardPersistingTaps: () => keepKeyboard
}))
vi.mock('./shell-terminal-key-rail', () => ({
  useShellTerminalKeyRail: (
    _shown: boolean,
    onKey: (key: string) => void,
    _owner: string,
    toolbar: BridgeTerminalToolbar
  ) => {
    shellLayout.toolbar = toolbar
    shellLayout.onKey = onKey
    return shellLayout.keys
  }
}))
import { MobileSessionCommandDock } from './MobileSessionCommandDock'

let renderer: ReturnType<typeof create> | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.clearAllMocks()
  shellLayout.padAvailable = false
  shellLayout.sideRail = false
  shellLayout.keys = []
})
function style(node: ReactTestInstance) {
  const value =
    typeof node.props.style === 'function' ? node.props.style({ pressed: false }) : node.props.style
  return Object.assign({}, ...[value].flat(Infinity).filter(Boolean))
}
function harness() {
  const bind = vi.fn()
  const focus = vi.fn(() => input.focus())
  const change = vi.fn()
  const pressIn = vi.fn()
  const pressOut = vi.fn()
  const attach = vi.fn()
  const dismiss = vi.fn()
  const base = mountFixture<MobileSessionController>({
    insets: { top: 0, left: 0, right: 0, bottom: 34 },
    activeHandle: 'a',
    activeHandleRef: { current: 'a' },
    customKeys: [],
    visibleBuiltInAccessoryKeys: [],
    terminalModes: new Map(),
    bufferedTerminalDraftState: { input: '', setInput: vi.fn() },
    liveInputEnabled: true,
    liveInputCapture: '',
    keyboardLift: 0,
    keyboardHeight: 0,
    canCompose: true,
    canSend: true,
    dictationEnabled: true,
    dictationMode: 'hold',
    dictation: { isStarting: false, isRecording: false, isProcessing: false },
    isAttaching: false,
    bindLiveInputField: bind,
    focusLiveInput: focus,
    dismissSoftwareKeyboard: dismiss,
    handleLiveInputChange: change,
    handleLiveInputKeyPress: vi.fn(),
    submitLiveInput: vi.fn(),
    handleDictationPressIn: pressIn,
    handleDictationPressOut: pressOut,
    attachImage: attach
  })
  const render = (overrides: Partial<MobileSessionController> = {}) =>
    act(() => {
      const element = createElement(MobileSessionCommandDock, {
        controller: { ...base, ...overrides }
      })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  render()
  const button = (label: string) =>
    renderer!.root.find(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
    )
  const field = () => renderer!.root.find((node) => String(node.type) === 'TextInput')
  const focusRow = () =>
    renderer!.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        ['Show keyboard for live terminal input', 'Hide keyboard for live terminal input'].includes(
          node.props.accessibilityLabel
        ) &&
        node.props.hitSlop === undefined
    ).parent!
  return {
    base,
    render,
    button,
    field,
    focusRow,
    bind,
    focus,
    change,
    pressIn,
    pressOut,
    attach,
    dismiss
  }
}

it('keeps the original long live input bar and bound field through keyboard, IME and focus transitions', () => {
  const h = harness()
  expect(style(h.focusRow()).position).toBeUndefined()
  expect(style(h.button('Show keyboard for live terminal input'))).toMatchObject({ flex: 1 })
  expect(
    renderer!.root.findAll(
      (node) => String(node.type) === 'Text' && node.props.children === 'Live input'
    )
  ).toHaveLength(1)
  expect(
    renderer!.root.findAll(
      (node) => String(node.type) === 'Text' && node.props.children === 'Tap to show keyboard'
    )
  ).toHaveLength(1)
  const originalField = h.field()
  act(() => h.button('Show keyboard for live terminal input').props.onPress())
  expect(input.focus).toHaveBeenCalledOnce()
  h.render({ keyboardHeight: 334, keyboardLift: 300 })
  expect(style(h.focusRow()).position).toBeUndefined()
  const preedit = { nativeEvent: { text: 'に', isComposing: true } }
  act(() => h.field().props.onChange(preedit))
  expect(h.change).toHaveBeenCalledWith(preedit)
  h.render({ liveInputCapture: 'に' })
  expect(style(h.focusRow()).position).toBeUndefined()
  h.render({ activeHandle: 'b', activeHandleRef: { current: 'b' } })
  expect(style(h.focusRow()).position).toBeUndefined()
  expect(h.field()).toBe(originalField)
  expect(h.bind.mock.calls).toEqual([[input]])
  expect(h.field().props.blurOnSubmit).toBe(false)
})

it('keeps a held dictation control mounted when recording updates the row', () => {
  const h = harness()
  const mic = h.button('Start voice dictation')
  act(() => mic.props.onPressIn())
  h.render({ dictation: { ...h.base.dictation, isStarting: true } })
  expect(style(h.focusRow()).position).toBeUndefined()
  expect(h.button('Starting voice dictation')).toBe(mic)
  h.render({ dictation: { ...h.base.dictation, isRecording: true } })
  act(() => h.button('Stop voice dictation').props.onPressOut())
  expect(h.pressIn).toHaveBeenCalledOnce()
  expect(h.pressOut).toHaveBeenCalledOnce()
  expect(h.bind.mock.calls).toEqual([[input]])
})

it.each(['isStarting', 'isRecording', 'isProcessing'] as const)(
  'shows live status while dictation %s',
  (state) => {
    const h = harness()
    h.render({ dictation: { ...h.base.dictation, [state]: true } })
    expect(style(h.focusRow()).position).toBeUndefined()
  }
)

it('keeps attachment entry points and upload status, and switches to buffered input', () => {
  const h = harness()
  act(() => h.button('Attach a photo').props.onPress())
  act(() => h.button('Attach a photo').props.onLongPress())
  expect(h.attach.mock.calls).toEqual([['library'], ['files']])
  h.render({ isAttaching: true })
  expect(style(h.focusRow()).position).toBeUndefined()
  expect(h.button('Sending image').props.disabled).toBe(true)
  h.render({ liveInputEnabled: false })
  expect(h.field().props.placeholder).toBe('Type a command…')
  expect(h.button('Send command')).toBeDefined()
})

it('preserves the OS inset without adding input-row bottom padding or altering keyboard translation', () => {
  const h = harness()
  const dock = () => renderer!.root.findAll((node) => String(node.type) === 'View')[0]
  expect(style(dock()).paddingBottom).toBe(34)
  h.render({ keyboardHeight: 334, keyboardLift: 300 })
  expect(style(dock())).toMatchObject({ paddingBottom: 34, transform: [{ translateY: -300 }] })
  expect(style(h.focusRow()).paddingBottom).toBe(0)
  h.render({ insets: { ...h.base.insets, bottom: 0 } })
  expect(style(dock()).paddingBottom).toBe(6)
})

it.each([
  { keyboardHeight: 334, keyboardLift: 300 },
  { keyboardHeight: 334, keyboardLift: 0 },
  { keyboardHeight: 0, keyboardLift: 300 }
])(
  'keeps the long live input bar and separate dismissal with keyboard measurements %j',
  (keyboard) => {
    const h = harness()
    const originalField = h.field()
    const mic = h.button('Start voice dictation')
    h.render(keyboard)
    expect(style(h.focusRow()).position).toBeUndefined()
    const dismiss = h.button('Dismiss keyboard')
    expect(h.focusRow().props.ref).toBe(keepKeyboard)
    expect(
      renderer!.root.findAll(
        (node) =>
          String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Dismiss keyboard'
      )
    ).toHaveLength(1)
    expect(dismiss.findAll((node) => String(node.type) === 'ChevronDown')).toHaveLength(1)
    expect(h.button('Hide keyboard for live terminal input')).toBeDefined()
    expect(
      renderer!.root.findAll(
        (node) => String(node.type) === 'Text' && node.props.children === 'Live input'
      )
    ).toHaveLength(1)
    act(() => dismiss.props.onPress())
    expect(h.dismiss).toHaveBeenCalledOnce()
    expect(h.focus).not.toHaveBeenCalled()
    expect(h.field()).toBe(originalField)
    expect(h.button('Start voice dictation')).toBe(mic)
    h.render()
    act(() => h.button('Show keyboard for live terminal input').props.onPress())
    expect(h.focus).toHaveBeenCalledOnce()
  }
)

it('allows separate keyboard dismissal while disconnected but disables the live input focus target', () => {
  const h = harness()
  h.render({ canSend: false, keyboardHeight: 334 })
  const dismiss = h.button('Dismiss keyboard')
  expect(dismiss.props.disabled).not.toBe(true)
  act(() => dismiss.props.onPress())
  expect(h.dismiss).toHaveBeenCalledOnce()
  h.render({ canSend: false })
  expect(h.button('Show keyboard for live terminal input').props.disabled).toBe(true)
})

it.each([
  { liveInputCapture: 'に' },
  { isAttaching: true },
  { dictation: { isStarting: true, isRecording: false, isProcessing: false } },
  { liveInputEnabled: false }
])('preserves separate dismissal for expanded input %j', (state) => {
  const h = harness()
  h.render({
    keyboardHeight: 334,
    ...state,
    dictation: { ...h.base.dictation, ...state.dictation }
  })
  const dismiss = h.button('Dismiss keyboard')
  act(() => dismiss.props.onPress())
  expect(h.dismiss).toHaveBeenCalledOnce()
  if (state.liveInputEnabled !== false) {
    act(() => h.button('Hide keyboard for live terminal input').props.onPress())
    expect(h.focus).not.toHaveBeenCalled()
    expect(h.dismiss).toHaveBeenCalledTimes(2)
  }
})

it('reclaims idle side-rail padding for the original live and buffered rows without changing keyboard geometry', () => {
  const h = harness()
  const dock = () => renderer!.root.findAll((node) => String(node.type) === 'View')[0]
  expect(style(dock()).paddingBottom).toBe(34)
  shellLayout.sideRail = true
  h.render()
  expect(style(dock()).paddingBottom).toBe(6)
  for (const keyboard of [
    { keyboardHeight: 334, keyboardLift: 300 },
    { keyboardHeight: 334, keyboardLift: 0 },
    { keyboardHeight: 0, keyboardLift: 300 }
  ]) {
    h.render(keyboard)
    expect(style(dock())).toMatchObject({
      paddingBottom: 34,
      transform: [{ translateY: -keyboard.keyboardLift }]
    })
  }
  for (const expanded of [
    { liveInputCapture: 'に' },
    { isAttaching: true },
    { dictation: { ...h.base.dictation, isRecording: true } },
    { liveInputEnabled: false }
  ]) {
    h.render(expanded)
    expect(style(dock()).paddingBottom).toBe(6)
  }
  h.render()
  expect(style(dock()).paddingBottom).toBe(6)
  shellLayout.padAvailable = false
  shellLayout.sideRail = false
  shellLayout.keys = []
  h.render()
  expect(style(dock()).paddingBottom).toBe(34)
})

it('removes the whole accessory row only after the host accepts the toolbar, keeping the live field mounted', () => {
  const h = harness()
  const field = h.field()
  shellLayout.keys = ['escape']
  h.render()
  expect(renderer!.root.findAll((node) => String(node.type) === 'ScrollView')).toHaveLength(1)
  shellLayout.keys = ['toggleKeyboard', 'toggleDisplayMode', 'toggleInputMode', 'addCustomKey']
  h.render()
  expect(renderer!.root.findAll((node) => String(node.type) === 'ScrollView')).toHaveLength(0)
  expect(h.field()).toBe(field)
  act(() => shellLayout.onKey('toggleKeyboard'))
  expect(h.focus).toHaveBeenCalledOnce()
  h.render({ keyboardHeight: 300, keyboardLift: 266 })
  act(() => shellLayout.onKey('toggleKeyboard'))
  expect(h.dismiss).toHaveBeenCalledOnce()
})
it('uses the long live input target to dismiss an open keyboard even while disconnected', () => {
  const h = harness()
  h.render({ keyboardHeight: 300, keyboardLift: 266, canSend: false })
  const toggle = h.button('Hide keyboard for live terminal input')
  expect(toggle.props.disabled).toBe(false)
  act(() => toggle.props.onPress())
  expect(h.dismiss).toHaveBeenCalledOnce()
  expect(h.focus).not.toHaveBeenCalled()
})

it('routes rail modes, custom send/delete and add to the existing controller and rejects stale-pane actions', () => {
  const h = harness()
  const toggleMode = vi.fn(),
    toggleInput = vi.fn(),
    showCustom = vi.fn(),
    deleteCustom = vi.fn(),
    accessory = vi.fn()
  const custom = { id: 'build', label: 'Build', bytes: 'make\r', enter: false }
  const state = {
    customKeys: [custom],
    toggleDisplayMode: toggleMode,
    toggleLiveInput: toggleInput,
    setShowCustomKeyModal: showCustom,
    setDeleteKeyTarget: deleteCustom,
    handleAccessoryKey: accessory
  }
  h.render(state)
  act(() => {
    shellLayout.onKey('toggleDisplayMode')
    shellLayout.onKey('toggleInputMode')
    shellLayout.onKey('addCustomKey')
    shellLayout.onKey('custom:build')
    shellLayout.onKey('deleteCustom:build')
  })
  expect(toggleMode).toHaveBeenCalledExactlyOnceWith('a')
  expect(toggleInput).toHaveBeenCalledOnce()
  expect(showCustom).toHaveBeenCalledExactlyOnceWith(true)
  expect(accessory).toHaveBeenCalledExactlyOnceWith({ bytes: 'make\r' })
  expect(deleteCustom).toHaveBeenCalledExactlyOnceWith(custom)
  h.render({ ...state, activeHandleRef: { current: 'next-pane' } })
  act(() => {
    shellLayout.onKey('custom:build')
    shellLayout.onKey('deleteCustom:build')
    shellLayout.onKey('toggleDisplayMode')
  })
  expect(accessory).toHaveBeenCalledOnce()
  expect(deleteCustom).toHaveBeenCalledOnce()
  expect(toggleMode).toHaveBeenCalledOnce()
})

it('stops rail actions while the custom shortcut editor or confirmation covers the terminal', () => {
  const h = harness(),
    accessory = vi.fn()
  for (const overlay of [
    { showCustomKeyModal: true },
    { deleteKeyTarget: { id: 'one', label: 'One', bytes: '1', enter: false } }
  ]) {
    h.render({ ...overlay, handleAccessoryKey: accessory })
    act(() => shellLayout.onKey('enter'))
  }
  expect(accessory).not.toHaveBeenCalled()
})

it('publishes the same ordered visible shortcuts as the retained dock and preserves the pad setting', () => {
  const h = harness()
  h.render({
    directionPadEnabled: false,
    visibleBuiltInAccessoryKeys: getVisibleTerminalAccessoryKeys(['ctrlU', 'tab']),
    customKeys: [
      { id: 'last', label: 'Last', bytes: 'l', enter: false },
      { id: 'hidden', label: 'Hidden', bytes: 'h', enter: false, visible: false },
      { id: 'first', label: 'First', bytes: 'f', enter: false }
    ]
  })
  expect(shellLayout.toolbar).toMatchObject({
    visibleBuiltInIds: ['ctrlU', 'tab'],
    directionPadEnabled: false,
    customKeys: [
      { id: 'last', label: 'Last' },
      { id: 'first', label: 'First' }
    ]
  })
  const labels = renderer!.root
    .findAll((node) => String(node.type) === 'Pressable')
    .map((node) => node.props.accessibilityLabel)
  expect(labels).not.toContain('Send Hidden')
  expect(labels.indexOf('Clear line before cursor')).toBeLessThan(labels.indexOf('Tab'))
  expect(labels.indexOf('Send Last')).toBeLessThan(labels.indexOf('Send First'))
})

it('offers unsaved directional fallback when the keyboard covers the entire D-pad rail', () => {
  shellLayout.padAvailable = true
  const h = harness()
  const visible = getVisibleTerminalAccessoryKeys(['tab'])
  const accessory = vi.fn()
  h.render({
    directionPadEnabled: true,
    keyboardHeight: 600,
    visibleBuiltInAccessoryKeys: visible,
    handleAccessoryKey: accessory,
    startAccessoryRepeat: vi.fn(),
    stopAccessoryRepeat: vi.fn()
  })
  const up = renderer!.root.findByProps({ accessibilityLabel: 'Arrow Up' })
  act(() => {
    up.props.onPressIn()
    up.props.onPressOut()
  })
  expect(accessory).toHaveBeenCalled()
  expect(visible.map((key) => key.id)).toEqual(['tab'])
  expect(shellLayout.toolbar?.visibleBuiltInIds).toEqual(['tab'])
  h.render({ directionPadEnabled: false, visibleBuiltInAccessoryKeys: visible })
  expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Arrow Up' })).toHaveLength(0)
})
