/**
 * Each WSL bridge pane remembers its distro's boot id from its spawn, so an exit the running list
 * calls 'running' can still be told apart as the distro having been terminated and booted again.
 * Reads go through the background-work gate (E9): only into a distro a fresh list says is running.
 */
import { isWslDistroRunningForBackgroundWork } from '../wsl-background-distro-gate'
import { readWslDistroBootId } from '../wsl/wsl-distro-boot-id'

export type WslBridgeBootIdentityDeps = {
  isRunning: (distro: string) => Promise<boolean>
  /** Null when the id could not be read. */
  readBootId: (distro: string) => Promise<string | null>
}

const PRODUCTION_DEPS: WslBridgeBootIdentityDeps = {
  isRunning: isWslDistroRunningForBackgroundWork,
  readBootId: readWslDistroBootId
}

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

export class WslBridgeBootIdentity {
  // One read per distro while any of its panes lives; a reboot exits them all, which drops it.
  private readonly byDistro = new Map<string, Promise<string | null>>()
  private readonly bySession = new Map<string, { distro: string; bootId: Promise<string | null> }>()

  constructor(private readonly deps: WslBridgeBootIdentityDeps = PRODUCTION_DEPS) {}

  noteSpawn(sessionId: string, distro: string): void {
    const key = distroKey(distro)
    const current = this.bySession.get(sessionId)
    if (current?.distro === key) {
      return
    }
    let bootId = this.byDistro.get(key)
    if (!bootId) {
      bootId = this.read(distro)
      this.byDistro.set(key, bootId)
    }
    this.bySession.set(sessionId, { distro: key, bootId })
  }

  /** After a bridge exit the running list answered 'running': has the distro booted again since? */
  async rebootedSinceSpawn(sessionId: string, distro: string): Promise<boolean> {
    // Any exit may be the first of a reboot's, so no later spawn reuses the old id.
    this.byDistro.delete(distroKey(distro))
    const spawned = this.bySession.get(sessionId)
    if (!spawned) {
      return false
    }
    const [before, now] = await Promise.all([spawned.bootId, this.read(distro)])
    // An unreadable id on either side proves nothing: the exit stays an exit.
    return before !== null && now !== null && before !== now
  }

  forget(sessionId: string): void {
    const spawned = this.bySession.get(sessionId)
    this.bySession.delete(sessionId)
    if (spawned && ![...this.bySession.values()].some(({ distro }) => distro === spawned.distro)) {
      this.byDistro.delete(spawned.distro)
    }
  }

  private async read(distro: string): Promise<string | null> {
    try {
      return (await this.deps.isRunning(distro)) ? await this.deps.readBootId(distro) : null
    } catch {
      return null
    }
  }
}
