import type { IPtyProvider } from '../providers/pty-provider-contract'
export function combineUnsubscribes(unsubscribes: (() => void)[]): () => void {
  return () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  }
}

export function trackProviderReplaySubscription(
  providers: IPtyProvider[],
  unsubscribers: (() => void)[],
  callback: Parameters<IPtyProvider['onReplay']>[0]
): () => void {
  const unsubscribes = providers.map((provider) => provider.onReplay(callback))
  let active = true
  const trackedUnsubscribe = (): void => {
    if (!active) {
      return
    }
    active = false
    const idx = unsubscribers.indexOf(trackedUnsubscribe)
    if (idx !== -1) {
      unsubscribers.splice(idx, 1)
    }
    combineUnsubscribes(unsubscribes)()
  }
  unsubscribers.push(trackedUnsubscribe)
  return trackedUnsubscribe
}
