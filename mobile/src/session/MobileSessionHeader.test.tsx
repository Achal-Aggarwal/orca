import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { MobileSessionController } from './use-mobile-session-controller'

const layout = vi.hoisted(() => ({ sideRail: true }))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Folder: 'Icon',
  GitBranch: 'Icon',
  MoreHorizontal: 'Icon',
  PanelLeftOpen: 'Icon'
}))
vi.mock('./MobileSessionHeaderIconButton', () => ({
  MobileSessionHeaderIconButton: 'HeaderButton'
}))
vi.mock('./MobileSessionTabStrip', () => ({ MobileSessionTabStrip: 'TabStrip' }))
vi.mock('../components/StatusDot', () => ({ StatusDot: 'StatusDot' }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../layout/host-sidebar-reveal', () => ({ useHostSidebarReveal: () => null }))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isLandscapePhone: false })
}))
vi.mock('../layout/use-top-chrome-space', () => ({ useTopChromeSpace: () => ({}) }))
vi.mock('../layout/use-shell-side-rail', () => ({ useShellSideRail: () => layout.sideRail }))

import { MobileSessionHeader } from './MobileSessionHeader'

let tree: ReactTestRenderer | undefined

afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  layout.sideRail = true
})

function renderHeader(showConnectionRetry: boolean) {
  const forceReconnectHost = vi.fn(async (_hostId: string) => {})
  const controller = mountFixture<MobileSessionController>({
    hostId: 'host-1',
    presentedConnState: showConnectionRetry ? 'disconnected' : 'connected',
    forceReconnectHost,
    worktreeName: 'Workspace',
    visibleTabs: [{ id: 'tab-a', type: 'terminal', terminal: 'a' }],
    showConnectionRetry,
    terminalSummary: showConnectionRetry ? 'Connection lost — tap to retry' : '1 tab'
  })
  act(() => {
    tree = create(createElement(MobileSessionHeader, { controller }))
  })
  return forceReconnectHost
}

it('keeps reconnect reachable beside the Duo tabs when the connection is escalated', async () => {
  const reconnect = renderHeader(true)
  const retry = tree!.root.findAllByProps({ accessibilityLabel: 'Reconnect to desktop' })
  expect(retry).toHaveLength(1)
  expect(retry[0].props.disabled).toBe(false)
  expect(tree!.root.find((node) => String(node.type) === 'StatusDot').props.state).toBe(
    'disconnected'
  )
  await act(async () => retry[0].props.onPress())
  expect(reconnect.mock.calls).toEqual([['host-1']])
})

it('keeps a connected Duo header compact while its tabs stay in the top bar', () => {
  renderHeader(false)
  expect(tree!.root.findAllByProps({ accessibilityLabel: 'Reconnect to desktop' })).toHaveLength(0)
  expect(tree!.root.findAll((node) => String(node.type) === 'StatusDot')).toHaveLength(0)
  expect(tree!.root.findAll((node) => String(node.type) === 'Text')).toHaveLength(0)
  expect(tree!.root.find((node) => String(node.type) === 'TabStrip').props.inTopBar).toBe(true)
})
