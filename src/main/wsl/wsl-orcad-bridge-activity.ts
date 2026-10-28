/**
 * The bridged loopback sockets a WSL host's listener carries (the desktop's own control and
 * request connections), read as a liveness watch so no extra wsl.exe bridge is held just to see
 * orcad exit. A channel the guest ended first means orcad closed the socket or exited.
 */
import type { RemoteCommandChannel } from '../managed-server/install/remote-install-transport'
import type { WslOrcadWatch } from './wsl-orcad-watch'

export type WslOrcadBridgeChannelEvents = {
  opened(): void
  /** `byGuest` when the guest side ended before the desktop closed or ended its side. */
  ended(byGuest: boolean): void
}

/** Reports a bridge channel's lifetime; a close or stdin EOF from the desktop is not the guest's. */
export function observeWslOrcadBridgeChannel(
  channel: RemoteCommandChannel,
  events: WslOrcadBridgeChannelEvents
): RemoteCommandChannel {
  let closedLocally = false
  const close = channel.close.bind(channel)
  channel.close = () => {
    closedLocally = true
    close()
  }
  // Decided when the guest's output ends: by then the desktop may already be hanging up in turn.
  const guestFirst = (): boolean => !closedLocally && !channel.writableEnded
  let byGuest: boolean | null = null
  channel.once('end', () => {
    byGuest ??= guestFirst()
  })
  events.opened()
  channel.once('exit', () => events.ended(byGuest ?? guestFirst()))
  return channel
}

export class WslOrcadBridgeActivity {
  private readonly live = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()

  events(environmentId: string): WslOrcadBridgeChannelEvents {
    const key = environmentId
    return {
      opened: () => this.live.set(key, (this.live.get(key) ?? 0) + 1),
      ended: (byGuest) => {
        this.live.set(key, Math.max(0, (this.live.get(key) ?? 0) - 1))
        if (byGuest) {
          // A listener detaches itself as it fires.
          for (const listener of Array.from(this.listeners.get(key) ?? [])) {
            listener()
          }
        }
      }
    }
  }

  /** A watch that fires once when the guest ends any bridged socket, and proves only while one is open. */
  watch(environmentId: string): WslOrcadWatch {
    const key = environmentId
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    this.listeners.set(key, listeners)
    let fire: (() => void) | null = null
    const detach = (): void => {
      if (fire) {
        listeners.delete(fire)
        fire = null
      }
    }
    return {
      signal: 'ready',
      onExit: (listener) => {
        detach()
        const once = (): void => {
          detach()
          listener(null)
        }
        fire = once
        listeners.add(once)
      },
      close: detach,
      proving: () => (this.live.get(key) ?? 0) > 0
    }
  }
}

/** Probes the port with a short-lived bridge, then watches the desktop's own bridged sockets. */
export async function probeThenWatchWslOrcadBridges(
  probe: () => Promise<WslOrcadWatch>,
  activity: WslOrcadBridgeActivity,
  environmentId: string
): Promise<WslOrcadWatch> {
  const probed = await probe()
  if (probed.signal !== 'ready') {
    return probed
  }
  probed.close()
  return activity.watch(environmentId)
}
