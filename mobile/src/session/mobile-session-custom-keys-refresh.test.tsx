import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveCustomKeys, type CustomKey } from '../terminal/terminal-custom-keys'
import { TERMINAL_ACCESSORY_KEYS } from '../terminal/terminal-accessory-keys'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'
import { MobileSessionAccessoryKeys } from './MobileSessionAccessoryKeys'
import { useMobileSessionLifecycle } from './use-mobile-session-lifecycle'

const state = vi.hoisted(() => ({
  focused: true,
  storage: new Map<string, string>(),
  appStateListeners: new Set<(state: string) => void>(),
  pendingKeyRead: new Map<string, Promise<string | null>>(),
  failedKeyReads: new Set<string>(),
  reads: 0
}))

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Platform: { OS: 'ios' },
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      state.appStateListeners.add(listener)
      return { remove: () => state.appStateListeners.delete(listener) }
    }
  }
}))
vi.mock('expo-router', async () => {
  const react = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      react.useEffect(() => (state.focused ? effect() : undefined), [effect, state.focused])
    }
  }
})
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (key === 'orca:custom-accessory-keys') {
        state.reads += 1
        if (state.failedKeyReads.delete('next')) {
          throw new Error('storage temporarily unavailable')
        }
        const read = state.pendingKeyRead.get('next')
        if (read) {
          state.pendingKeyRead.clear()
          return read
        }
      }
      return state.storage.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      state.storage.set(key, value)
    }
  }
}))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronsRight: 'ChevronsRight',
  Keyboard: 'Keyboard',
  Monitor: 'Monitor',
  Plus: 'Plus',
  Smartphone: 'Smartphone'
}))
vi.mock('../transport/host-store', () => ({ loadHosts: async () => [] }))
vi.mock('../terminal/terminal-foreground-recovery', () => ({
  recoverActiveTerminalAfterForeground: vi.fn(),
  shouldRecoverTerminalOnAppStateChange: () => false
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('../platform/keyboard-persisting-taps', () => ({ useKeyboardPersistingTaps: () => null }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: vi.fn() }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))

const oldKey = { id: 'old', label: 'Old', bytes: 'old', enter: false }
const newKey = { id: 'new', label: 'New', bytes: 'new\r', enter: false }
const otherKey = { id: 'other', label: 'Other', bytes: 'other', enter: false }
const send = vi.fn()
const noop = () => {}
let renderer: ReactTestRenderer | null = null
let acceptLocalKeys: (keys: CustomKey[]) => void = noop

function Harness() {
  const [customKeys, setCustomKeys] = useState<CustomKey[]>([])
  const [visibleBuiltInIds, setVisibleBuiltInIds] = useState<string[]>([])
  acceptLocalKeys = setCustomKeys
  const scope = {
    hostId: 'host',
    connState: 'connected',
    customKeys,
    setCustomKeys,
    setVisibleBuiltInIds,
    setHostEndpoint: noop,
    connStateRef: { current: 'connected' },
    terminalRefs: { current: new Map() },
    initializedHandlesRef: { current: new Set() },
    activeHandleRef: { current: 'pty' },
    scheduleDelayedAction: noop,
    unsubscribeTerminal: noop,
    subscribeToTerminal: noop
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real lifecycle reads only these supplied session members.
  const lifecycle = useMobileSessionLifecycle(scope as never)
  if (!lifecycle.accessoryPreferencesReady) {
    return null
  }
  const controller = {
    activeHandle: 'pty',
    customKeys,
    visibleBuiltInAccessoryKeys: TERMINAL_ACCESSORY_KEYS.filter((key) =>
      visibleBuiltInIds.includes(key.id)
    ),
    terminalModes: new Map(),
    canPaste: false,
    canSend: true,
    canCompose: true,
    liveInputEnabled: true,
    keyboardLift: 0,
    setShowCustomKeyModal: noop,
    setDeleteKeyTarget: noop,
    toggleDisplayMode: noop,
    handleAccessoryKey: send,
    dismissSoftwareKeyboard: noop,
    toggleLiveInput: noop,
    stopAccessoryRepeat: noop,
    startAccessoryRepeat: noop,
    handlePaste: noop
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real accessory bar reads only these supplied controller members.
  return createElement(MobileSessionAccessoryKeys, { controller: controller as never })
}

function shortcutButtons() {
  if (!renderer) {
    throw new Error('session not mounted')
  }
  return findAllByHostType(renderer.root, 'Pressable').filter((node) =>
    String(node.props.accessibilityLabel).startsWith('Send ')
  )
}

async function focus(focused: boolean) {
  state.focused = focused
  await act(async () => renderer?.update(createElement(Harness)))
}

beforeEach(() => {
  state.focused = true
  state.appStateListeners.clear()
  state.pendingKeyRead.clear()
  state.failedKeyReads.clear()
  state.reads = 0
  state.storage.clear()
  state.storage.set('orca:custom-accessory-keys', JSON.stringify([oldKey]))
  state.storage.set(
    'orca:terminal-accessory-layout',
    JSON.stringify({
      version: 2,
      orderedBuiltInIds: TERMINAL_ACCESSORY_KEYS.map((key) => key.id),
      visibleBuiltInIds: []
    })
  )
  send.mockClear()
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('session custom shortcuts after saved settings change', () => {
  it('refreshes the mounted accessory bar on Settings return and sends the saved bytes', async () => {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(shortcutButtons().map((node) => node.props.accessibilityLabel)).toEqual(['Send Old'])
    await focus(false)
    await saveCustomKeys([otherKey, newKey])
    await focus(true)
    expect(shortcutButtons().map((node) => node.props.accessibilityLabel)).toEqual([
      'Send Other',
      'Send New'
    ])
    await act(async () => shortcutButtons()[1].props.onPress())
    expect(send).toHaveBeenCalledExactlyOnceWith({ bytes: 'new\r' })
  })

  it('refreshes saved shortcuts when the mounted session returns to the foreground', async () => {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await saveCustomKeys([newKey])
    await act(async () => {
      for (const listener of state.appStateListeners) {
        listener('active')
      }
    })
    expect(shortcutButtons().map((node) => node.props.accessibilityLabel)).toEqual(['Send New'])
  })

  it('keeps live shortcuts after failed refresh storage and accepts the next successful refresh', async () => {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await focus(false)
    state.failedKeyReads.add('next')
    await focus(true)
    state.failedKeyReads.clear()
    expect(shortcutButtons().map((node) => node.props.accessibilityLabel)).toEqual(['Send Old'])
    await saveCustomKeys([newKey])
    await focus(false)
    await focus(true)
    expect(shortcutButtons().map((node) => node.props.accessibilityLabel)).toEqual(['Send New'])
  })

  it('keeps the live strip and a newer in-session edit while an older focus read settles', async () => {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await focus(false)
    let resolveRead: (value: string | null) => void = noop
    state.pendingKeyRead.set(
      'next',
      new Promise<string | null>((resolve) => {
        resolveRead = resolve
      })
    )
    const previousReads = state.reads
    await focus(true)
    expect(state.reads).toBe(previousReads + 1)
    expect(shortcutButtons().map((node) => node.props.accessibilityLabel)).toEqual(['Send Old'])
    await saveCustomKeys([newKey])
    act(() => acceptLocalKeys([newKey]))
    await act(async () => resolveRead(JSON.stringify([oldKey])))
    expect(shortcutButtons().map((node) => node.props.accessibilityLabel)).toEqual(['Send New'])
  })
})
