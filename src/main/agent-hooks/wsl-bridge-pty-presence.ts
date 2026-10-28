/**
 * Live local WSL (bridge) terminals per distro: the hook relay for a distro idles out only when
 * none remain. Fed by the PTY layer at spawn, reattach and exit.
 */
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'

type PresenceListener = (distro: string) => void

export class WslBridgePtyPresence {
  private readonly distroByPty = new Map<string, string>()
  private readonly listeners = new Set<PresenceListener>()

  noteLive(ptyId: string, distro: string): void {
    const key = wslHookRelayStateKey(distro)
    if (this.distroByPty.get(ptyId) === key) {
      return
    }
    const previous = this.distroByPty.get(ptyId)
    this.distroByPty.set(ptyId, key)
    if (previous) {
      this.notify(previous)
    }
    this.notify(key)
  }

  noteExited(ptyId: string): void {
    const key = this.distroByPty.get(ptyId)
    if (key) {
      this.distroByPty.delete(ptyId)
      this.notify(key)
    }
  }

  count(distro: string): number {
    const key = wslHookRelayStateKey(distro)
    let live = 0
    for (const candidate of this.distroByPty.values()) {
      live += candidate === key ? 1 : 0
    }
    return live
  }

  /** Called with the distro (state key) whose count changed. */
  onChange(listener: PresenceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(key: string): void {
    for (const listener of this.listeners) {
      listener(key)
    }
  }
}

export const wslBridgePtyPresence = new WslBridgePtyPresence()
