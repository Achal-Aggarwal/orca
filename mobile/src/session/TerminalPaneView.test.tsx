import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

const hosts = vi.hoisted(() => {
  const component = (name: string) => {
    const Host = (props: { children?: ReactNode }) => props.children ?? null
    Host.displayName = name
    return Host
  }
  return {
    View: component('View'),
    Text: component('Text'),
    Pressable: component('Pressable'),
    TerminalWebView: component('TerminalWebView')
  }
})
vi.mock('react-native', () => ({
  View: hosts.View,
  Text: hosts.Text,
  Pressable: hosts.Pressable,
  StyleSheet: {
    create: <T,>(value: T) => value,
    absoluteFillObject: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }
  }
}))
vi.mock('../terminal/TerminalWebView', () => ({ TerminalWebView: hosts.TerminalWebView }))
import { TerminalPaneView } from './TerminalPaneView'

type Props = Parameters<typeof TerminalPaneView>[0]

it.each([0, 1])(
  'keeps stacked pane %i visible above a tall keyboard and preserves its measured terminal frame',
  (index) => {
    const onFrame = vi.fn()
    const base = mountFixture<Props>({
      handle: `term-${index}`,
      active: true,
      visible: true,
      splitIndex: index,
      splitDirection: 'column',
      splitFrame: { width: 390, height: 500 },
      keyboardInset: 0,
      keyboardLift: 0,
      textScale: 1,
      onFrame,
      onRef: vi.fn()
    })
    let renderer!: ReturnType<typeof create>
    try {
      act(() => {
        renderer = create(createElement(TerminalPaneView, base))
      })
      const views = () => renderer.root.findAllByType(hosts.View)
      expect(views()[2].props.style.height).toBe(222)
      act(() => {
        renderer.update(
          createElement(TerminalPaneView, { ...base, keyboardInset: 300, keyboardLift: 150 })
        )
      })
      const [outer, clip, measured] = views()
      const outerStyle = Object.assign({}, ...outer.props.style.filter(Boolean))
      expect(outerStyle.top).toBe(index * 100)
      expect(outerStyle.height).toBe(100)
      expect(clip.props.style.overflow).toBe('hidden')
      expect(measured.props.style.height).toBe(222)
      act(() => {
        measured.props.onLayout({ nativeEvent: { layout: { width: 390, height: 222 } } })
      })
      expect(onFrame).toHaveBeenLastCalledWith(`term-${index}`, { width: 390, height: 222 })
      const terminal = renderer.root.findByType(hosts.TerminalWebView)
      const terminalStyle = Object.assign({}, ...terminal.props.style.filter(Boolean))
      const bottom =
        outerStyle.top + 28 + measured.props.style.height + terminalStyle.transform[0].translateY
      expect(bottom).toBe(index * 100 + 100)
      expect(bottom).toBeGreaterThan(outerStyle.top + 28)
      expect(bottom).toBeLessThanOrEqual(200)
    } finally {
      act(() => renderer?.unmount())
    }
  }
)
