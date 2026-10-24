import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  SafeAreaProvider,
  useSafeAreaFrame,
  useSafeAreaInsets,
  type EdgeInsets
} from 'react-native-safe-area-context'

import { useReservedRegions } from './reserved-regions'
import { getSideRailStrip } from './side-rail-strip'

const WindowSafeAreaInsetsContext = createContext<EdgeInsets | null>(null)

/**
 * Lays the app out clear of the window's side insets, which landscape brings: the iPhone sensor
 * housing, an Android side navigation bar or cutout. Below it the insets and frame describe the
 * padded area, so no screen pads a side twice or sizes past it.
 */
export function SideSafeArea({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets()
  const frame = useSafeAreaFrame()
  const { windowSafeArea, occlusions } = useReservedRegions()
  const duoStrip =
    windowSafeArea &&
    getSideRailStrip({
      windowWidth: windowSafeArea.bounds.width,
      windowHeight: windowSafeArea.bounds.height,
      insets: windowSafeArea.insets,
      occlusions
    })
  // Empirical iOS 27.1 Duo workaround: its top 20pt reject touches despite zero top safe inset.
  const topPadding = Platform.OS === 'ios' && duoStrip ? Math.max(0, 20 - Math.max(0, frame.y)) : 0
  const areaInsets = useMemo(
    () => ({ ...insets, top: Math.max(0, insets.top - topPadding), left: 0, right: 0 }),
    [insets, topPadding]
  )
  const areaFrame = useMemo(
    () => ({
      ...frame,
      x: frame.x + insets.left,
      y: frame.y + topPadding,
      height: Math.max(0, frame.height - topPadding),
      width: Math.max(0, frame.width - insets.left - insets.right)
    }),
    [frame, insets.left, insets.right, topPadding]
  )
  const area = (
    <WindowSafeAreaInsetsContext.Provider value={insets}>
      <SafeAreaFrameContext.Provider value={areaFrame}>
        <SafeAreaInsetsContext.Provider value={areaInsets}>
          {children}
        </SafeAreaInsetsContext.Provider>
      </SafeAreaFrameContext.Provider>
    </WindowSafeAreaInsetsContext.Provider>
  )
  // A native SafeAreaView measures against the nearest native provider rather than the context, so
  // one goes inside the padding; on the web it reads the context.
  return (
    <View
      style={[
        styles.area,
        { paddingLeft: insets.left, paddingRight: insets.right, paddingTop: topPadding }
      ]}
    >
      {Platform.OS === 'web' ? area : <SafeAreaProvider>{area}</SafeAreaProvider>}
    </View>
  )
}

/** The window's insets, for a Modal: it opens a window of its own, outside `SideSafeArea`. */
export function useWindowSafeAreaInsets(): EdgeInsets {
  const insets = useSafeAreaInsets()
  return useContext(WindowSafeAreaInsetsContext) ?? insets
}

const styles = StyleSheet.create({
  area: { flex: 1 }
})
