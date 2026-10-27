import type { WorkspacePortScanResult, WorkspacePortProbe } from '../../shared/workspace-ports'
import { isPortScanWorkerUnavailableError } from './port-scan-command-client'
import { PortScanCommandTimeoutError } from './port-scan-command-protocol'
import {
  WorkspacePortScanTimeoutBackoff,
  type WorkspacePortScanTimeoutBackoffSnapshot
} from './workspace-port-scan-timeout-backoff'

const SLOW_SPAWN_SKIP_METADATA_MS = 2_000
// Reprobe periodically so a listening process's changed cwd cannot stay cached forever.
const METADATA_REPROBE_INTERVAL_SCANS = 10
const commandTimeoutBackoff = new WorkspacePortScanTimeoutBackoff()
let loggedWorkerUnavailable = false
let skippedMetadataOnLastScan = false
let lastListenerMetadata = new Map<string, RememberedListenerMetadata>()
let metadataScanSequence = 0
let reusedListenerKeys = new Set<string>()

export type WorkspacePortScanOptions = {
  requireMetadata?: boolean
  /** WSL distros holding scanned workspaces; their forwarded listeners resolve inside the guest. */
  wslDistros?: readonly string[]
}

export type RawListeningPort = {
  host: string
  port: number
  pid?: number
  processName?: string
  /** Kernel socket identity from `lsof -F d`; a new socket on the same pid:port gets a new one. */
  socketId?: string
  commandLine?: string
  cwd?: string
  /** Owned by this WSL guest process behind wslrelay.exe; `pid` is the relay's. */
  wslGuest?: WslGuestListenerOwner
}

export type WslGuestListenerOwner = { distro: string; pid: number }

export type ProcessMetadata = {
  processName?: string
  commandLine?: string
  cwd?: string
  wslGuest?: WslGuestListenerOwner
}

type RememberedListenerMetadata = ProcessMetadata & {
  socketId?: string
  probedAtScan: number
}

export type NormalizedWorkspacePortProbe = {
  worktree: WorkspacePortProbe
  normalizedPath: string
}

export type PlatformListeningPortScan = {
  ports: RawListeningPort[]
  metadataAvailable: boolean
}

export function getWorkspacePortScanCooldown(): WorkspacePortScanTimeoutBackoffSnapshot {
  return commandTimeoutBackoff.snapshot()
}

export function recordWorkspacePortScanSuccess(): void {
  commandTimeoutBackoff.recordSuccess()
}

export function recordWorkspacePortScanTimeout(): void {
  commandTimeoutBackoff.recordTimeout()
}

export function resetWorkspacePortScanTimeoutBackoffForTests(): void {
  commandTimeoutBackoff.reset()
  loggedWorkerUnavailable = false
  skippedMetadataOnLastScan = false
  lastListenerMetadata = new Map()
  metadataScanSequence = 0
  reusedListenerKeys = new Set()
}

export function shouldSkipMetadataCommands(
  spawnMs: number,
  options: WorkspacePortScanOptions
): boolean {
  if (options.requireMetadata) {
    return false
  }
  const skip = spawnMs > SLOW_SPAWN_SKIP_METADATA_MS && !skippedMetadataOnLastScan
  skippedMetadataOnLastScan = skip
  return skip
}

function listenerMetadataKey(port: RawListeningPort): string {
  return `${port.pid ?? 'unknown'}:${port.host}:${port.port}`
}

/** Consume reuse keys recorded by partitionListenersNeedingMetadata in this scan. */
export function rememberListenerMetadata(ports: readonly RawListeningPort[]): void {
  const previous = lastListenerMetadata
  lastListenerMetadata = new Map()
  for (const port of ports) {
    const key = listenerMetadataKey(port)
    // Reuse must preserve original probe age or the staleness limit never expires.
    const probedAtScan = reusedListenerKeys.has(key)
      ? (previous.get(key)?.probedAtScan ?? metadataScanSequence)
      : metadataScanSequence
    lastListenerMetadata.set(key, {
      processName: port.processName,
      socketId: port.socketId,
      commandLine: port.commandLine,
      cwd: port.cwd,
      ...(port.wslGuest ? { wslGuest: port.wslGuest } : {}),
      probedAtScan
    })
  }
  reusedListenerKeys = new Set()
}

/** Reuse name/socket-matching metadata until its age limit; record reused keys for rememberListenerMetadata. */
export function partitionListenersNeedingMetadata(
  ports: readonly RawListeningPort[],
  options: WorkspacePortScanOptions = {}
): { hydrated: RawListeningPort[]; pidsNeedingMetadata: Set<number> } {
  metadataScanSequence += 1
  reusedListenerKeys = new Set()
  // SIGTERM authorization requires fresh attribution; cached cwd cannot prove ownership.
  if (options.requireMetadata) {
    return {
      hydrated: [...ports],
      pidsNeedingMetadata: new Set(ports.flatMap((port) => (port.pid ? [port.pid] : [])))
    }
  }
  const hydrated: RawListeningPort[] = []
  const pidsNeedingMetadata = new Set<number>()
  const reusableByPort = new Map<RawListeningPort, ProcessMetadata>()
  for (const port of ports) {
    const remembered = lastListenerMetadata.get(listenerMetadataKey(port))
    // Empty probe results cannot count as reusable metadata.
    if (
      remembered?.commandLine !== undefined &&
      remembered.processName === port.processName &&
      port.socketId !== undefined &&
      remembered.socketId === port.socketId &&
      metadataScanSequence - remembered.probedAtScan < METADATA_REPROBE_INTERVAL_SCANS &&
      port.pid !== undefined
    ) {
      reusableByPort.set(port, remembered)
      continue
    }
    if (port.pid !== undefined) {
      pidsNeedingMetadata.add(port.pid)
    }
  }
  // Reprobe every socket for a PID together, or one process could appear in two workspaces.
  for (const port of ports) {
    const remembered =
      port.pid !== undefined && !pidsNeedingMetadata.has(port.pid)
        ? reusableByPort.get(port)
        : undefined
    if (remembered) {
      reusedListenerKeys.add(listenerMetadataKey(port))
      hydrated.push({
        ...port,
        commandLine: port.commandLine ?? remembered.commandLine,
        cwd: port.cwd ?? remembered.cwd
      })
      continue
    }
    hydrated.push(port)
  }
  return { hydrated, pidsNeedingMetadata }
}

export function recallListenerMetadata(port: RawListeningPort): RawListeningPort {
  const remembered = lastListenerMetadata.get(listenerMetadataKey(port))
  if (!remembered) {
    return port
  }
  if (remembered.wslGuest) {
    // Mixing fresh relay fields with a cached guest owner would attribute neither coherently.
    const { processName, commandLine, cwd, wslGuest } = remembered
    return {
      host: port.host,
      port: port.port,
      pid: port.pid,
      processName,
      commandLine,
      cwd,
      wslGuest
    }
  }
  return {
    ...port,
    processName: port.processName ?? remembered.processName,
    commandLine: port.commandLine ?? remembered.commandLine,
    cwd: port.cwd ?? remembered.cwd
  }
}

export function warnWorkspacePortScanFailure(error: unknown): void {
  if (isPortScanWorkerUnavailableError(error)) {
    if (loggedWorkerUnavailable) {
      return
    }
    loggedWorkerUnavailable = true
  }
  console.warn('[workspace-ports] scan failed', error)
}

export function isWorkspacePortScanCommandTimeout(error: unknown): boolean {
  return error instanceof PortScanCommandTimeoutError
}

export function makeUnavailableWorkspacePortScan(reason: string): WorkspacePortScanResult {
  return {
    platform: process.platform,
    scannedAt: Date.now(),
    ports: [],
    unavailableReason: reason
  }
}
