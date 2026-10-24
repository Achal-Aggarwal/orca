import { useEffect } from 'react'
import { z } from 'zod'
import type { ReservedRect, WindowSafeArea } from '../../modules/orca-reserved-regions/src'
import {
  BRIDGE_MAX_SAFE_AREA_INSET,
  BridgeSafeAreaInsetsSchema,
  type BridgeSafeAreaInsets
} from './bridge/bridge-safe-area-insets'

const coordinate = z
  .number()
  .finite()
  .min(-BRIDGE_MAX_SAFE_AREA_INSET)
  .max(BRIDGE_MAX_SAFE_AREA_INSET)
const extent = z.number().finite().positive().max(BRIDGE_MAX_SAFE_AREA_INSET)
const frameSchema = z.object({ x: coordinate, y: coordinate, width: extent, height: extent })
const windowSafeAreaSchema = z
  .object({ bounds: frameSchema, insets: BridgeSafeAreaInsetsSchema })
  .refine(
    ({ bounds, insets }) =>
      insets.left + insets.right <= bounds.width && insets.top + insets.bottom <= bounds.height,
    'Safe area exceeds window bounds'
  )

/** Insets from the window's safe rectangle, translated into the actual WebView frame. */
export function measuredPageSafeAreaInsets(
  windowSafeArea: WindowSafeArea | undefined,
  frame: ReservedRect | null,
  fallback: BridgeSafeAreaInsets
): BridgeSafeAreaInsets {
  if (windowSafeArea === undefined || frame === null) {
    return fallback
  }
  const window = windowSafeAreaSchema.safeParse(windowSafeArea)
  const page = frameSchema.safeParse(frame)
  if (!window.success || !page.success) {
    console.warn('[web-shell] invalid measured safe-area geometry', {
      windowIssue: window.success ? undefined : window.error.message,
      pageIssue: page.success ? undefined : page.error.message
    })
    return fallback
  }
  const { bounds, insets } = window.data
  const { x, y, width, height } = page.data
  return {
    top: Math.min(height, Math.max(0, bounds.y + insets.top - y)),
    right: Math.min(width, Math.max(0, x + width - (bounds.x + bounds.width - insets.right))),
    bottom: Math.min(height, Math.max(0, y + height - (bounds.y + bounds.height - insets.bottom))),
    left: Math.min(width, Math.max(0, bounds.x + insets.left - x))
  }
}

/**
 * The part of an edge-to-edge WebView that sits under a system bar, which is what the page pads for.
 *
 * The window's insets, as a native screen reads them with the keyboard covering it, except where
 * the shell's banner stands above the view and takes the status bar strip itself.
 */
export function pageSafeAreaInsets(input: {
  insets: BridgeSafeAreaInsets
  topCovered: boolean
}): BridgeSafeAreaInsets {
  const { insets } = input
  return {
    top: input.topCovered ? 0 : insets.top,
    right: insets.right,
    bottom: insets.bottom,
    left: insets.left
  }
}

/** Hands moved insets to the page over the re-sent `init` a pane move takes: a rotation or the
 *  shell's banner. Keyed on the four numbers, so a render moves nothing. */
export function usePublishedSafeAreaInsets(
  publish: (insets: BridgeSafeAreaInsets) => void,
  insets: BridgeSafeAreaInsets
): void {
  const { top, right, bottom, left } = insets
  useEffect(() => {
    publish({ top, right, bottom, left })
  }, [publish, top, right, bottom, left])
}
