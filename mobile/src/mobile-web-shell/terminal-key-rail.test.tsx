import { createElement, type ReactNode } from 'react'
import { ScrollView } from 'react-native'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS } from '../terminal/terminal-key-definitions'
import type { SideRailStrip } from '../layout/side-rail-strip'

const outlet = vi.hoisted((): { node: ReactNode } => ({ node: null }))
const appState = vi.hoisted(() => ({ listener: (_state: string) => {}, remove: vi.fn() }))
const railState = vi.hoisted((): { strip: SideRailStrip | null; capable: boolean } => ({
  strip: null,
  capable: true
}))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listener = listener
      return { remove: appState.remove }
    }
  },
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('lucide-react-native', () => ({
  Keyboard: 'KeyboardIcon',
  ChevronDown: 'ChevronDown',
  Monitor: 'Monitor',
  Smartphone: 'Smartphone',
  ChevronsRight: 'ChevronsRight',
  Plus: 'Plus'
}))
vi.mock('expo-router', async () => ({ useFocusEffect: (await import('react')).useEffect }))
vi.mock('../layout/side-rail', () => ({
  useSideRailContent: (node: ReactNode) => {
    outlet.node = node
  },
  useSideRailDirectionPadAvailable: () => railState.capable,
  useSideRailStrip: () => railState.strip
}))
import {
  TerminalKeyRail,
  terminalKeyRailKeys,
  useShellKeyRail,
  usePublishedShellKeyRail
} from './terminal-key-rail'
import type { BridgeTerminalToolbar } from './bridge/bridge-terminal-key'

let renderer: ReturnType<typeof create> | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  railState.strip = null
  railState.capable = true
  vi.useRealTimers()
})

it.each(['left', 'right'] as const)(
  '%s rail pins the pad when it fits and scrolls it above the keyboard when short',
  async (side) => {
    vi.useFakeTimers()
    railState.strip = { side, width: 84, height: 500, top: 0, bottom: 0 }
    const toolbar = {
      canSend: true,
      canCompose: true,
      canPaste: true,
      keyboardVisible: false,
      liveInputEnabled: true,
      phoneDisplayMode: false,
      customKeys: [],
      directionPadEnabled: true,
      visibleBuiltInIds: ['tab']
    }
    const send = vi.fn(() => true)
    let keys = terminalKeyRailKeys(500, toolbar)
    const render = () =>
      act(() => {
        const element = createElement(TerminalKeyRail, {
          keys,
          toolbar,
          onKey: send
        })
        if (renderer) {
          renderer.update(element)
        } else {
          renderer = create(element)
        }
      })
    render()
    const scroll = renderer!.root.findByType(ScrollView)
    expect(renderer!.root.findAllByProps({ accessibilityLabel: 'D-pad up' })).toHaveLength(1)
    expect(scroll.findAllByProps({ accessibilityLabel: 'D-pad up' })).toHaveLength(0)
    expect(scroll.findAllByProps({ accessibilityLabel: 'Arrow Up' })).toHaveLength(0)
    const up = renderer!.root.findByProps({ accessibilityLabel: 'D-pad up' })
    act(() => {
      up.props.onPressIn(touch(20))
      up.props.onLongPress()
      scroll.props.onScrollBeginDrag()
      up.props.onPressOut()
      up.props.onPress()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(send).toHaveBeenCalledExactlyOnceWith('arrowUp')
    railState.strip = { ...railState.strip, height: 145 }
    render()
    const shortScroll = renderer!.root.findByType(ScrollView)
    const shortUp = shortScroll.findByProps({ accessibilityLabel: 'D-pad up' })
    const sentBefore = send.mock.calls.length
    act(() => {
      shortUp.props.onPressIn(touch(20))
      shortScroll.props.onTouchMove(touch(22))
      shortUp.props.onPressOut()
      shortUp.props.onPress()
    })
    expect(send).toHaveBeenCalledTimes(sentBefore + 1)
    expect(send).toHaveBeenLastCalledWith('arrowUp')
    act(() => {
      shortUp.props.onPressIn(touch(20))
      shortScroll.props.onScrollBeginDrag()
      shortUp.props.onPressOut()
      shortUp.props.onPress()
    })
    expect(send).toHaveBeenCalledTimes(sentBefore + 1)
    expect(shortScroll.findAllByProps({ accessibilityLabel: 'Arrow Up' })).toHaveLength(0)
    toolbar.directionPadEnabled = false
    render()
    expect(renderer!.root.findAllByProps({ accessibilityLabel: 'D-pad up' })).toHaveLength(0)
    toolbar.directionPadEnabled = true
    railState.capable = false
    railState.strip = { ...railState.strip, height: 500, side: 'left' }
    render()
    expect(renderer!.root.findAllByProps({ accessibilityLabel: 'D-pad up' })).toHaveLength(0)
  }
)
function mount() {
  const send = vi.fn((_key: string) => true)
  act(() => {
    renderer = create(
      createElement(TerminalKeyRail, { keys: terminalKeyRailKeys(100), onKey: send })
    )
  })
  const root = renderer!.root
  const key = (label: string): ReactTestInstance => root.findByProps({ accessibilityLabel: label })
  return { send, root, key }
}
const touch = (pageY: number) => ({ nativeEvent: { pageX: 20, pageY } })
it('publishes the complete key vocabulary even when only two buttons fit', () => {
  expect([...terminalKeyRailKeys(100)].sort()).toEqual(
    [...TERMINAL_ACCESSORY_KEY_DEFINITIONS.map((key) => key.id), 'paste'].sort()
  )
  expect(terminalKeyRailKeys(0)).toEqual([])
})

it('uses a vertical scroll view and sends a tap only on release', () => {
  const { send, root, key } = mount()
  expect(root.findByType(ScrollView).props.horizontal).not.toBe(true)
  const arrow = key('Arrow Up')
  act(() => arrow.props.onPressIn(touch(20)))
  expect(send).not.toHaveBeenCalled()
  act(() => {
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  expect(send).toHaveBeenCalledExactlyOnceWith('arrowUp')
})
it('cancels a swipe starting on a key before it can send or repeat', async () => {
  vi.useFakeTimers()
  const { send, root, key } = mount()
  const arrow = key('Arrow Up')
  act(() => arrow.props.onPressIn(touch(20)))
  act(() => root.findByType(ScrollView).props.onTouchMove(touch(40)))
  act(() => {
    arrow.props.onLongPress()
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(send).not.toHaveBeenCalled()
})
it('repeats a held key and cancels on drag, release, and unmount without an extra tap', async () => {
  vi.useFakeTimers()
  const { send, root, key } = mount()
  const arrow = key('Arrow Down')
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onLongPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(445)
  })
  expect(send.mock.calls.length).toBeGreaterThan(1)
  act(() => root.findByType(ScrollView).props.onScrollBeginDrag())
  const count = send.mock.calls.length
  act(() => {
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(send).toHaveBeenCalledTimes(count)
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onLongPress()
  })
  act(() => renderer?.unmount())
  renderer = undefined
  const afterUnmount = send.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(send).toHaveBeenCalledTimes(afterUnmount)
})

it.each(['release', 'background', 'touch cancel'])('stops a held repeat on %s', async (reason) => {
  vi.useFakeTimers()
  const { send, root, key } = mount()
  const arrow = key('Arrow Up')
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onLongPress()
  })
  expect(send).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45)
  })
  expect(send).toHaveBeenCalledTimes(2)
  act(() => {
    if (reason === 'release') {
      arrow.props.onPressOut()
    } else if (reason === 'background') {
      appState.listener('background')
    } else {
      root.findByType(ScrollView).props.onTouchCancel()
    }
    arrow.props.onPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(send).toHaveBeenCalledTimes(2)
})
it('does not send a non-repeatable key during a swipe', () => {
  const { send, root, key } = mount()
  const escape = key('Escape')
  act(() => {
    escape.props.onPressIn(touch(20))
    root.findByType(ScrollView).props.onTouchMove(touch(40))
    escape.props.onPressOut()
    escape.props.onPress()
  })
  expect(send).not.toHaveBeenCalled()
})
it.each([
  ['Escape', 'escape'],
  ['Tab', 'tab'],
  ['Interrupt terminal', 'ctrlC'],
  ['Paste from clipboard', 'paste']
])('sends held non-repeatable %s on release under native long-press suppression', (label, id) => {
  const { send, key } = mount()
  const button = key(label)
  act(() => {
    button.props.onPressIn(touch(20))
    button.props.onLongPress?.()
    button.props.onPressOut()
    // RN Pressability suppresses release onPress after a long press when a handler exists.
    if (button.props.onLongPress == null) {
      button.props.onPress()
    }
  })
  expect(send).toHaveBeenCalledExactlyOnceWith(id)
})

it('renders stateful toolbar and custom keys in the same scroll view with protected gestures', () => {
  const toolbar = {
    canSend: true,
    canCompose: true,
    canPaste: true,
    keyboardVisible: false,
    liveInputEnabled: true,
    phoneDisplayMode: false,
    customKeys: [{ id: 'build', label: 'Build' }]
  }
  const send = vi.fn((_key: string) => true)
  const render = (next = toolbar) =>
    act(() => {
      const element = createElement(TerminalKeyRail, {
        keys: terminalKeyRailKeys(100, next),
        toolbar: next,
        onKey: send
      })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  render()
  const key = (label: string) => renderer!.root.findByProps({ accessibilityLabel: label })
  const press = (label: string) =>
    act(() => {
      const button = key(label)
      button.props.onPressIn(touch(20))
      button.props.onPressOut()
      button.props.onPress()
    })
  press('Show keyboard')
  press('Switch to phone mode')
  press('Switch to buffered command input')
  press('Add custom shortcut')
  press('Send Build')
  expect(send.mock.calls.map(([key]) => key)).toEqual([
    'toggleKeyboard',
    'toggleDisplayMode',
    'toggleInputMode',
    'addCustomKey',
    'custom:build'
  ])
  send.mockClear()
  const custom = key('Send Build')
  act(() => {
    custom.props.onPressIn(touch(20))
    custom.props.onLongPress()
    custom.props.onPressOut()
    custom.props.onPress()
  })
  expect(send).toHaveBeenCalledExactlyOnceWith('deleteCustom:build')
  render({ ...toolbar, keyboardVisible: true, canSend: false })
  expect(key('Dismiss keyboard').props.disabled).toBe(false)
  expect(key('Switch to phone mode').props.disabled).toBe(true)
  expect(key('Send Build').props.disabled).toBe(true)
  press('Dismiss keyboard')
  expect(send).toHaveBeenLastCalledWith('toggleKeyboard')
})

it('renders saved built-in order and visibility independently from the D-pad and custom order', () => {
  railState.strip = { side: 'right', width: 84, height: 500, top: 0, bottom: 0 }
  let toolbar = {
    canSend: true,
    canCompose: true,
    canPaste: false,
    keyboardVisible: false,
    liveInputEnabled: true,
    phoneDisplayMode: false,
    visibleBuiltInIds: ['ctrlU', 'tab'],
    directionPadEnabled: true,
    customKeys: [
      { id: 'second', label: 'Second' },
      { id: 'first', label: 'First' }
    ]
  }
  const send = vi.fn(() => true)
  const render = () =>
    act(() => {
      const element = createElement(TerminalKeyRail, {
        keys: terminalKeyRailKeys(500, toolbar),
        toolbar,
        onKey: send
      })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  render()
  const labels = () =>
    renderer!.root
      .findByType(ScrollView)
      .findAll((node) => String(node.type) === 'Pressable')
      .map((node) => node.props.accessibilityLabel)
  expect(labels()).toEqual([
    'Show keyboard',
    'Switch to phone mode',
    'Switch to buffered command input',
    'Clear line before cursor',
    'Tab',
    'Send Second',
    'Send First',
    'Add custom shortcut'
  ])
  expect(renderer!.root.findAllByProps({ accessibilityLabel: 'D-pad up' })).toHaveLength(1)
  act(() => {
    const up = renderer!.root.findByProps({ accessibilityLabel: 'D-pad up' })
    up.props.onPressIn(touch(20))
    up.props.onPressOut()
    up.props.onPress()
  })
  expect(send).toHaveBeenCalledWith('arrowUp')
  toolbar = { ...toolbar, directionPadEnabled: false }
  render()
  expect(renderer!.root.findAllByProps({ accessibilityLabel: 'D-pad up' })).toHaveLength(0)
  expect(labels()).not.toContain('Arrow Up')
})

function mountRailHost() {
  railState.strip = { side: 'right', width: 84, height: 500, top: 0, bottom: 0 }
  const bridge = { publishTerminalKeyRail: vi.fn(), sendTerminalKey: vi.fn(() => true) }
  let reportClaim: ReturnType<typeof useShellKeyRail>['reportClaim'] = () => {}
  function TerminalKeyRailHost({ overlay = false }: { overlay?: boolean }) {
    const rail = useShellKeyRail({
      sessionId: 'session',
      overlay,
      routeGrants: ['terminalKeyRail']
    })
    reportClaim = rail.reportClaim
    usePublishedShellKeyRail(rail.keys, bridge, rail.inputOwner, rail.toolbar)
    return outlet.node
  }
  act(() => {
    renderer = create(createElement(TerminalKeyRailHost))
  })
  const toolbar: BridgeTerminalToolbar = {
    canSend: true,
    canCompose: true,
    canPaste: true,
    keyboardVisible: false,
    liveInputEnabled: true,
    phoneDisplayMode: false,
    directionPadEnabled: false,
    visibleBuiltInIds: ['arrowUp'],
    customKeys: [{ id: 'build', label: 'Build' }]
  }
  const claim = (owner = 'pane-a', next = toolbar) =>
    act(() => {
      reportClaim(true, owner, structuredClone(next))
    })
  claim()
  const arrow = () => renderer!.root.findByProps({ accessibilityLabel: 'Arrow Up' })
  return {
    bridge,
    claim,
    arrow,
    toolbar,
    reportClaim,
    refresh: () => act(() => renderer!.update(createElement(TerminalKeyRailHost))),
    cover: () => act(() => renderer!.update(createElement(TerminalKeyRailHost, { overlay: true })))
  }
}

it('keeps the scroll view mounted when the focused pane changes', () => {
  const h = mountRailHost()
  const scroll = renderer!.root.findByType(ScrollView)
  h.claim('pane-b')
  expect(renderer!.root.findByType(ScrollView)).toBe(scroll)
  const arrow = h.arrow()
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  expect(h.bridge.sendTerminalKey).toHaveBeenCalledExactlyOnceWith('arrowUp', 'pane-b')
})

it('delivers a release tap across an equivalent serialized rail claim', () => {
  const h = mountRailHost()
  const arrow = h.arrow()
  act(() => arrow.props.onPressIn(touch(20)))
  h.claim()
  act(() => {
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  expect(h.bridge.sendTerminalKey).toHaveBeenCalledExactlyOnceWith('arrowUp', 'pane-a')
})

it('continues held repeats across an equivalent serialized rail claim', async () => {
  vi.useFakeTimers()
  const h = mountRailHost()
  act(() => {
    h.arrow().props.onPressIn(touch(20))
    h.arrow().props.onLongPress()
  })
  h.claim()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90)
  })
  expect(h.bridge.sendTerminalKey).toHaveBeenCalledTimes(3)
  expect(h.bridge.sendTerminalKey).toHaveBeenLastCalledWith('arrowUp', 'pane-a')
  act(() => {
    h.arrow().props.onPressOut()
    h.arrow().props.onPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90)
  })
  expect(h.bridge.sendTerminalKey).toHaveBeenCalledTimes(3)
})

it.each(['owner', 'toolbar', 'keys', 'release', 'overlay', 'layout'])(
  'cancels held rail input on a real %s change',
  async (change) => {
    vi.useFakeTimers()
    const h = mountRailHost()
    act(() => {
      h.arrow().props.onPressIn(touch(20))
      h.arrow().props.onLongPress()
    })
    if (change === 'owner') {
      h.claim('pane-b')
    }
    if (change === 'toolbar') {
      h.claim('pane-a', { ...h.toolbar, canSend: false })
    }
    if (change === 'keys') {
      h.claim('pane-a', { ...h.toolbar, visibleBuiltInIds: ['arrowUp', 'tab'] })
    }
    if (change === 'release') {
      act(() => h.reportClaim(false))
    }
    if (change === 'overlay') {
      h.cover()
    }
    if (change === 'layout') {
      railState.strip = { side: 'right', width: 84, height: 140, top: 0, bottom: 0 }
      h.refresh()
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90)
    })
    expect(h.bridge.sendTerminalKey).toHaveBeenCalledExactlyOnceWith('arrowUp', 'pane-a')
  }
)

it('cancels held input when only the owner changes and keys stay identical', async () => {
  vi.useFakeTimers()
  railState.strip = { side: 'right', width: 84, height: 500, top: 0, bottom: 0 }
  const toolbar: BridgeTerminalToolbar = {
    canSend: true,
    canCompose: true,
    canPaste: true,
    keyboardVisible: false,
    liveInputEnabled: true,
    phoneDisplayMode: false,
    directionPadEnabled: false,
    visibleBuiltInIds: ['arrowUp'],
    customKeys: []
  }
  const keys = terminalKeyRailKeys(500, toolbar)
  const send = vi.fn(() => true)
  const render = (inputOwner: string) =>
    act(() => {
      const node = createElement(TerminalKeyRail, { keys, toolbar, onKey: send, inputOwner })
      if (renderer) {
        renderer.update(node)
      } else {
        renderer = create(node)
      }
    })
  render('pane-a')
  const arrow = renderer!.root.findByProps({ accessibilityLabel: 'Arrow Up' })
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onLongPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90)
  })
  expect(send).toHaveBeenCalledTimes(3)
  const sent = send.mock.calls.length
  render('pane-b')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(180)
  })
  act(() => {
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  expect(send).toHaveBeenCalledTimes(sent)
})
