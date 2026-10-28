import {
  isWslHostsInternalGateOpen,
  resolveWslHostsGateState,
  type WslHostsGateState
} from '../../shared/wsl-host-internal-gate'
import type { OrcadDeploymentLink } from '../../shared/runtime-environments'

export const WSL_HOSTS_GATED_OFF_MESSAGE = 'WSL hosts are not available in this build.'

// Fixed for the run once main reads the disk; nothing can create a host or a move while not open.
let promoted: { hasSavedWslHost: boolean; hasCommittedWslMove: boolean } | null = null

/** Startup, before any gate check: a closed gate with saved WSL work becomes `serve-only`. */
export function configureWslHostsGate(facts: {
  hasSavedWslHost: () => boolean
  hasCommittedWslMove: () => boolean
}): void {
  if (wslHostsGateOpen()) {
    promoted = null
    return
  }
  // Unreadable state counts as absent: today's closed behavior.
  const read = (fact: () => boolean): boolean => {
    try {
      return fact()
    } catch {
      return false
    }
  }
  promoted = {
    hasSavedWslHost: read(facts.hasSavedWslHost),
    hasCommittedWslMove: read(facts.hasCommittedWslMove)
  }
}

export function resetWslHostsGateForTests(): void {
  promoted = null
}

export function wslHostsGateState(): WslHostsGateState {
  return resolveWslHostsGateState({
    gateOpen: wslHostsGateOpen(),
    hasSavedWslHost: promoted?.hasSavedWslHost ?? false,
    hasCommittedWslMove: promoted?.hasCommittedWslMove ?? false
  })
}

/** The internal gate itself: adding hosts and starting moves need it. */
export function wslHostsGateOpen(): boolean {
  return isWslHostsInternalGateOpen(process.env)
}

/** Saved hosts and moved projects stay reachable: `open` or `serve-only`. */
export function wslHostsServing(): boolean {
  return wslHostsGateState() !== 'closed'
}

/** A persisted WSL host while the gate is closed: left on disk, but never listed or reached. */
export function isGatedOffWslHost(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): boolean {
  return environment.orcadDeployment?.kind === 'wsl' && !wslHostsServing()
}

export function assertWslHostReachable(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): void {
  if (isGatedOffWslHost(environment)) {
    throw new Error(WSL_HOSTS_GATED_OFF_MESSAGE)
  }
}
