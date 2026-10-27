import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'

export type SwitchPresentationVisit = {
  stopObserving?: () => void
  captureVisible?: () => void
  itemVisible?: (id: string) => boolean
  presentedItems: Set<string>
  readable: boolean
  settled: boolean
  failureItemId?: string
  reporter?: 'inline' | 'clicked'
  shown: Promise<boolean>
  show: (shown: boolean) => void
  mounted: boolean
  visible: boolean
  release: () => void
}
const visits = new Map<string, SwitchPresentationVisit>()
const listeners = new Set<() => void>()
let revision = 0
const changed = () => {
  revision++
  for (const listener of listeners) {
    listener()
  }
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const keyFor = (target: RuntimeClientTarget, id: string) =>
  `${executionHostIdForStructuredTarget(target)}\0${id}`
export const SwitchPresentationContext = createContext<SwitchPresentationVisit | undefined>(
  undefined
)

/** Only this automatic visit owns the click's selected failure; a later manual visit reads history normally. */
export function beginSwitchPresentation(
  target: RuntimeClientTarget,
  id: string
): SwitchPresentationVisit {
  const key = keyFor(target, id)
  visits.get(key)?.release()
  let show!: (shown: boolean) => void
  const shown = new Promise<boolean>((resolve) => {
    show = resolve
  })
  const visit: SwitchPresentationVisit = {
    shown,
    show,
    presentedItems: new Set(),
    readable: false,
    settled: false,
    mounted: false,
    visible: false,
    release: () => {
      if (visits.get(key) === visit) {
        visit.show(false)
        visit.stopObserving?.()
        visits.delete(key)
        changed()
      }
    }
  }
  visits.set(key, visit)
  changed()
  return visit
}
export function reportSwitchPresentationFailure(
  visit: SwitchPresentationVisit,
  itemId?: string
): boolean {
  if (visit.reporter) {
    return false
  }
  visit.failureItemId = itemId
  visit.reporter =
    itemId && (visit.presentedItems.has(itemId) || (visit.visible && visit.itemVisible?.(itemId)))
      ? 'inline'
      : 'clicked'
  settleSwitchPresentation(visit)
  return visit.reporter === 'clicked'
}
export function settleSwitchPresentation(visit: SwitchPresentationVisit | undefined): void {
  if (!visit || visit.settled) {
    return
  }
  visit.settled = true
  visit.stopObserving?.()
  visit.presentedItems.clear()
  visit.captureVisible = undefined
  visit.itemVisible = undefined
  changed()
}
export function useSwitchPresentation(
  target: RuntimeClientTarget,
  id: string,
  visible: boolean,
  transcript: 'pending' | 'readable' | 'empty' | 'failed' = 'readable'
) {
  useSyncExternalStore(
    subscribe,
    () => revision,
    () => revision
  )
  const visit = visits.get(keyFor(target, id))
  useLayoutEffect(() => {
    if (!visit) {
      return
    }
    visit.mounted = true
    visit.visible = visible

    if (!visible) {
      visit.release()
    }
    return () => {
      visit.visible = false
      visit.release()
    }
  }, [visit, visible])
  useLayoutEffect(() => {
    if (!visit || !visible) {
      return
    }
    visit.readable = transcript === 'readable'
    if (transcript === 'empty') {
      visit.show(true)
    } else if (transcript === 'readable') {
      visit.captureVisible?.()
    } else if (transcript === 'failed') {
      visit.show(false)
    }
  }, [visit, visible, transcript])
  return visit
}
export function useSwitchPresentationRows(root: RefObject<HTMLDivElement | null>): void {
  const visit = useContext(SwitchPresentationContext)
  useLayoutEffect(() => {
    if (!visit || visit.settled) {
      return
    }
    const rowVisible = (row: HTMLElement): boolean => {
      const element = root.current
      if (!element || !element.isConnected) {
        return false
      }
      const bounds = element.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        rect.height > 0 &&
        rect.width > 0 &&
        rect.right > Math.max(0, bounds.left) &&
        rect.left < Math.min(window.innerWidth, bounds.right) &&
        rect.bottom > Math.max(0, bounds.top) &&
        rect.top < Math.min(window.innerHeight, bounds.bottom)
      )
    }
    const itemVisible = (id: string): boolean => {
      for (const row of root.current?.querySelectorAll<HTMLElement>('[data-switch-item-id]') ??
        []) {
        if (row.dataset.switchItemId === id) {
          return rowVisible(row)
        }
      }
      return false
    }
    visit.itemVisible = itemVisible
    const observe = () => {
      if (!visit.visible || visit.settled) {
        return
      }
      let shown = false
      for (const row of root.current?.querySelectorAll<HTMLElement>('[data-switch-item-id]') ??
        []) {
        const id = row.dataset.switchItemId
        if (id && rowVisible(row)) {
          visit.presentedItems.add(id)
          shown = true
        }
      }
      if (shown && visit.readable) {
        visit.show(true)
      }
    }
    visit.captureVisible = observe
    observe()
    const element = root.current
    element?.addEventListener('scroll', observe, { passive: true })
    const stop = () => {
      element?.removeEventListener('scroll', observe)
      if (visit.itemVisible === itemVisible) {
        visit.itemVisible = undefined
      }
      if (visit.captureVisible === observe) {
        visit.captureVisible = undefined
      }
      if (visit.stopObserving === stop) {
        visit.stopObserving = undefined
      }
    }
    visit.stopObserving = stop
    return () => {
      observe()
      stop()
    }
  })
}
export function useSwitchFailureSuppressed(itemId: string | undefined): boolean {
  const visit = useContext(SwitchPresentationContext)
  useSyncExternalStore(
    subscribe,
    () => revision,
    () => revision
  )
  return Boolean(itemId && visit?.failureItemId === itemId && visit.reporter === 'clicked')
}
