import { useEffect, useState } from 'react'
import { Dimensions, Keyboard } from 'react-native'
import { subscribeReservedRegionChanges } from '../layout/reserved-regions'
import { hostOs } from './host-os'

/** How much of the bottom of the layout viewport it covers, and whether it is open at all. */
export type SoftKeyboardState = { readonly height: number; readonly visible: boolean }

const CLOSED: SoftKeyboardState = { height: 0, visible: false }

/**
 * What the software keyboard is doing, from the events the platform sends. iOS is told `will`,
 * Android `did`, which is the difference between animating with the keyboard and after it. Both
 * facts from one subscription, because the session screen wants each and two hooks would cost it
 * duplicate listeners and renders per keyboard event.
 *
 * The web sibling is where this earns its place under `platform/`: react-native-web's `Keyboard` is
 * a stub — `addListener` returns a subscription that never fires and `isVisible()` is always false
 * — so a screen inside the shell's page that waits for a keyboard event waits forever, and the
 * software keyboard covers whatever sits at the bottom of the document. There the two facts come
 * apart, and neither is an event.
 */
export function useSoftKeyboard(): SoftKeyboardState {
  const [keyboard, setKeyboard] = useState<SoftKeyboardState>(CLOSED)

  useEffect(
    () =>
      // The keyboard's own height already describes the obscured area; the consumer adds whatever
      // clearance it wants above it. Open is the event, not the height: a keyboard that reports 0
      // is still one nobody wants the terminal re-fitted under.
      subscribeSoftKeyboard(
        (height) => setKeyboard({ height: Math.max(0, height), visible: true }),
        () => setKeyboard(CLOSED)
      ),
    []
  )

  return keyboard
}

/**
 * The keyboard as events, for a consumer that animates with each one (the event's `duration`) rather
 * than rendering from state. iOS is told `will`, Android `did`.
 */
type KeyboardSubscriber = {
  onShow: (height: number, duration: number) => void
  onHide: (duration: number) => void
}
const subscribers = new Set<KeyboardSubscriber>()
let observing = false

function observeSoftKeyboard(): void {
  if (observing) {
    return
  }
  observing = true
  const showEvent = hostOs() === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
  const hideEvent = hostOs() === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
  let hiding = false
  let visible = false
  const reportHeight = (height: number, duration: number) => {
    for (const subscriber of subscribers) {
      subscriber.onShow(height, duration)
    }
  }
  // App-lifetime observation preserves explicit hide even between subscriber mounts.
  Keyboard.addListener(showEvent, (event) => {
    hiding = false
    visible = true
    reportHeight(event.endCoordinates.height, event.duration)
  })
  Keyboard.addListener(hideEvent, (event) => {
    hiding = true
    visible = false
    for (const subscriber of subscribers) {
      subscriber.onHide(event.duration)
    }
  })
  if (hostOs() === 'ios') {
    Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      const { screenY, height } = event.endCoordinates
      // Hide frames keep a height; only show can reopen after an explicit hide.
      if (hiding || screenY >= Dimensions.get('window').height || screenY + height <= 0) {
        return
      }
      reportHeight(height, event.duration)
    })
    subscribeReservedRegionChanges(({ keyboardInset }) => {
      if (visible && keyboardInset !== undefined && keyboardInset > 0) {
        reportHeight(keyboardInset, 0)
      }
    })
  }
}

export function subscribeSoftKeyboard(
  onShow: (height: number, duration: number) => void,
  onHide: (duration: number) => void
): () => void {
  const subscriber = { onShow, onHide }
  subscribers.add(subscriber)
  observeSoftKeyboard()
  return () => {
    subscribers.delete(subscriber)
  }
}

/**
 * The keyboard already up, which sends no show event to a late subscriber. React Native sets this on
 * `did` events, so on iOS it can still read open between `willHide` and `didHide`.
 */
export function currentSoftKeyboardHeight(): number {
  return Keyboard.metrics()?.height ?? 0
}

/** The occluded strip alone, for the callers that lift by it and never ask whether it is open. */
export function useKeyboardOcclusion(): number {
  return useSoftKeyboard().height
}
