import { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  ChevronLeft,
  Folder,
  GitBranch,
  MoreHorizontal,
  PanelLeftOpen,
  Columns2,
  Plus,
  SquareChevronRight
} from 'lucide-react-native'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { MobileSessionHeaderMoreActionsSheet } from './MobileSessionHeaderMoreActionsSheet'
import { MobileSessionTabStrip } from './MobileSessionTabStrip'
import { StatusDot } from '../components/StatusDot'
import { styles } from './mobile-session-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import { useResponsiveLayout } from '../layout/responsive-layout'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useTopChromeSpace } from '../layout/use-top-chrome-space'
import { useShellSideRail } from '../layout/use-shell-side-rail'

export function MobileSessionHeader({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const {
    hostId,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    presentedConnState,
    forceReconnectHost,
    worktreeName,
    activePanel,
    setShowHeaderMoreActions,
    requestLeaveSession,
    visibleTabs,
    showConnectionRetry,
    connectionEscalated,
    terminalSummary,
    handlePanelTap,
    showHeaderMoreButton,
    showHeaderMoreActions,
    showAgentSessionHistoryAction,
    showChecksAction,
    openAgentSessionHistory,
    canSplitTerminals,
    terminalSplitActive,
    setShowTerminalLayout,
    connState,
    createTabBusy,
    handleOpenNewTab,
    handleOpenQuickCommands
  } = controller
  const layout = useResponsiveLayout()
  const [headerWidth, setHeaderWidth] = useState<number | null>(null)
  const revealSidebar = useHostSidebarReveal()
  const topChrome = useTopChromeSpace()
  const sideRail = useShellSideRail()
  // Why: a sideways phone is ~390pt tall, so the tabs share the top bar instead of taking a second row.
  const hasTabs = visibleTabs.length > 0
  const tabsInTopBar = (layout.isLandscapePhone || sideRail) && hasTabs
  // Six 44pt controls otherwise leave less than two readable tabs on a narrow header.
  const actionsCollapsed = tabsInTopBar && (headerWidth ?? layout.width) < 600
  const tabStrip = hasTabs ? (
    <MobileSessionTabStrip
      controller={controller}
      inTopBar={tabsInTopBar}
      actionsCollapsed={actionsCollapsed}
    />
  ) : null
  return (
    <View ref={topChrome.ref} onLayout={topChrome.onLayout}>
      <SafeAreaView
        style={[
          styles.sessionChrome,
          topChrome.space && {
            paddingLeft: topChrome.space.left,
            paddingRight: topChrome.space.right,
            minHeight: topChrome.space.minHeight
          }
        ]}
        edges={topChrome.space ? [] : ['top']}
      >
        <View
          style={styles.sessionTopBar}
          onLayout={(event) => {
            const width = event.nativeEvent.layout.width
            setHeaderWidth((previous) => (previous === width ? previous : width))
          }}
        >
          {revealSidebar ? (
            <MobileSessionHeaderIconButton
              accessibilityLabel="Show sidebar"
              icon={PanelLeftOpen}
              onPress={revealSidebar}
            />
          ) : null}
          <MobileSessionHeaderIconButton
            accessibilityLabel="Back to worktrees"
            icon={ChevronLeft}
            onPress={requestLeaveSession}
          />

          {!sideRail || !hasTabs || showConnectionRetry || connectionEscalated ? (
            <View
              style={[styles.sessionTitleBlock, tabsInTopBar && styles.sessionTitleBlockBesideTabs]}
            >
              <Text style={styles.sessionTitle} numberOfLines={1}>
                {worktreeName || 'Terminal'}
              </Text>
              <Pressable
                style={styles.sessionMetaRow}
                disabled={!showConnectionRetry}
                onPress={() => {
                  if (hostId && forceReconnectHost) {
                    void forceReconnectHost(hostId)
                  }
                }}
                accessibilityRole={showConnectionRetry ? 'button' : undefined}
                accessibilityLabel={showConnectionRetry ? 'Reconnect to desktop' : undefined}
              >
                <StatusDot state={presentedConnState} />
                <Text style={styles.sessionMetaText} numberOfLines={1}>
                  {terminalSummary}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {tabsInTopBar ? tabStrip : null}
          {!actionsCollapsed && !isFloatingWorkspaceRoute && (
            <MobileSessionHeaderIconButton
              active={activePanel === 'files'}
              accessibilityLabel="Open file explorer"
              icon={Folder}
              onPress={() => handlePanelTap('files')}
            />
          )}
          {!isFolderWorkspaceRoute && !actionsCollapsed && !isFloatingWorkspaceRoute && (
            <MobileSessionHeaderIconButton
              active={activePanel === 'sourceControl'}
              accessibilityLabel="Open source control"
              icon={GitBranch}
              onPress={() => handlePanelTap('sourceControl')}
            />
          )}
          {actionsCollapsed || showHeaderMoreButton ? (
            <MobileSessionHeaderIconButton
              active={activePanel === 'pr' || (actionsCollapsed && activePanel !== null)}
              accessibilityLabel="More session actions"
              icon={MoreHorizontal}
              onPress={() => setShowHeaderMoreActions(true)}
            />
          ) : null}
        </View>

        {tabsInTopBar ? null : tabStrip}
      </SafeAreaView>
      <MobileSessionHeaderMoreActionsSheet
        visible={showHeaderMoreActions}
        showAgentSessionHistory={showAgentSessionHistoryAction}
        showChecks={showChecksAction}
        onOpenAgentSessionHistory={openAgentSessionHistory}
        onOpenChecks={() => handlePanelTap('pr')}
        onClose={() => setShowHeaderMoreActions(false)}
        additionalActions={
          actionsCollapsed
            ? [
                ...(canSplitTerminals || terminalSplitActive
                  ? [
                      {
                        label: 'Terminal layout',
                        icon: Columns2,
                        closeBeforePress: true,
                        onPress: () => setShowTerminalLayout(true)
                      }
                    ]
                  : []),
                {
                  label: 'New tab',
                  icon: Plus,
                  disabled: createTabBusy || connState !== 'connected',
                  closeBeforePress: true,
                  onPress: handleOpenNewTab
                },
                {
                  label: 'Quick commands',
                  icon: SquareChevronRight,
                  disabled: createTabBusy || connState !== 'connected',
                  closeBeforePress: true,
                  onPress: handleOpenQuickCommands
                },
                ...(!isFloatingWorkspaceRoute
                  ? [
                      {
                        label: 'File explorer',
                        icon: Folder,
                        closeBeforePress: true,
                        onPress: () => handlePanelTap('files')
                      }
                    ]
                  : []),
                ...(!isFolderWorkspaceRoute && !isFloatingWorkspaceRoute
                  ? [
                      {
                        label: 'Source control',
                        icon: GitBranch,
                        closeBeforePress: true,
                        onPress: () => handlePanelTap('sourceControl')
                      }
                    ]
                  : [])
              ]
            : []
        }
      />
    </View>
  )
}
