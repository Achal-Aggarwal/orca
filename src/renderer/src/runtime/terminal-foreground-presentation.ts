import { admitRemoteForegroundEvidence } from '../../../shared/remote-foreground-evidence-admission'
import type { RemoteForegroundEvidence } from '../../../shared/foreground-process-evidence'
import {
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from '../../../shared/terminal-process-inspection'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'
import type { TerminalPresentationObservation } from '../../../shared/terminal-foreground-presentation'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { readLocalRuntimeCapabilitiesOrUnknown } from './local-runtime-capabilities'
import { readCachedRuntimeEnvironmentCapability } from './runtime-rpc-client'
import { TERMINAL_FOREGROUND_PRESENTATION_CAPABILITY } from '../../../shared/terminal-runtime-capabilities'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'

type Entry = {
  incarnationId?: string | null
  value?: TerminalPresentationObservation
  members: Set<string>
  sources: Set<string>
  listeners: Set<() => void>
  admission?: RemoteForegroundEvidence
  generations?: Set<string>
}
const entries = new Map<string, Entry>()
const scopes = new Map<string, Set<string>>()
function entryFor(id: string): Entry {
  let entry = entries.get(id)
  if (!entry) {
    entry = { listeners: new Set(), sources: new Set(), members: new Set() }
    entries.set(id, entry)
  }
  return entry
}
export function desktopPresentationSnapshot(id: string | null | undefined) {
  const entry = id ? entries.get(id) : undefined
  return entry?.sources.size ? entry.value : undefined
}
export function subscribeDesktopPresentation(id: string, listener: () => void): () => void {
  const entry = entryFor(id)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    if (!entry.listeners.size && !entry.members.size) {
      entries.delete(id)
    }
  }
}
export function desktopPresentationForExit(id: string | undefined) {
  const entry = id ? entries.get(id) : undefined
  if (entry?.value?.support) {
    return entry.value.support === 'legacy' ? 'gone' : desktopPresentationSnapshot(id)?.state
  }
  if (!id) {
    return undefined
  }
  const owner = getRemoteRuntimePtyOwner(id)
  const capabilities = readLocalRuntimeCapabilitiesOrUnknown()
  const supported = owner
    ? readCachedRuntimeEnvironmentCapability(
        owner.target.environmentId,
        TERMINAL_FOREGROUND_PRESENTATION_CAPABILITY
      )
    : capabilities?.includes(TERMINAL_FOREGROUND_PRESENTATION_CAPABILITY)
  return supported === false ? 'gone' : undefined
}
export function acceptDesktopPresentation(
  id: string,
  value: TerminalPresentationObservation,
  source = ''
): void {
  const entry = entryFor(id)
  const old = entry.value
  if (old?.incarnationId === value.incarnationId) {
    if (
      (old.support === 'supported' && value.support === 'legacy') ||
      value.version < old.version
    ) {
      return
    }
    if (value.version === old.version) {
      const visible = entry.sources.size > 0
      entry.sources.add(source)
      if (!visible) {
        for (const listener of entry.listeners) {
          listener()
        }
      }
      return
    }
  } else {
    entry.admission = undefined
    entry.generations = undefined
  }
  entry.sources = new Set([source])
  entry.value = value
  entry.incarnationId = value.incarnationId
  for (const listener of entry.listeners) {
    listener()
  }
}
export function deliverDesktopPresentationInspection(
  id: string,
  result: TerminalProcessInspection,
  request: { remote: boolean; expectedIncarnationId: string | null; startedAt: number }
): void {
  if (isClientOnlyUnverifiableInspection(result)) {
    return
  }
  const entry = entryFor(id)
  if (
    entry.incarnationId &&
    ((result.presentation && result.presentation.incarnationId !== entry.incarnationId) ||
      (request.expectedIncarnationId && request.expectedIncarnationId !== entry.incarnationId))
  ) {
    return
  }
  if (request.remote) {
    const current =
      entry.admission?.ptyIncarnationId === request.expectedIncarnationId
        ? entry.admission
        : undefined
    const evidence = admitRemoteForegroundEvidence(result.foregroundProcessEvidence, {
      expectedPtyId:
        parseAppSshPtyId(id)?.relayPtyId ?? getRemoteRuntimePtyOwner(id)?.terminal ?? id,
      expectedIncarnationId: request.expectedIncarnationId,
      requestStartedAtMonotonic: request.startedAt,
      receivedAtMonotonic: performance.now(),
      lastAuthorityGeneration: current?.authorityGeneration ?? null,
      lastObservationEpoch: current?.observationEpoch ?? -1,
      knownAuthorityGenerations: entry.generations
    })
    if (!evidence) {
      return
    }
    entry.admission = evidence
    ;(entry.generations ??= new Set()).add(evidence.authorityGeneration)
  }
  if (result.presentation) {
    acceptDesktopPresentation(id, result.presentation)
  } else {
    acceptDesktopPresentation(id, {
      support: 'legacy',
      incarnationId: request.expectedIncarnationId ?? entry.incarnationId ?? '',
      version: 0
    })
  }
}
export function retractDesktopPresentation(id: string, source?: string): void {
  const entry = entries.get(id)
  if (!entry) {
    return
  }
  const visible = entry.sources.size > 0
  if (source === undefined) {
    entry.sources.clear()
    entry.value = undefined
    entry.admission = undefined
    entry.generations = undefined
  } else {
    entry.sources.delete(source)
  }
  if (!entry.sources.size && !entry.listeners.size && !entry.members.size) {
    entries.delete(id)
  }
  if (visible && !entry.sources.size) {
    for (const listener of entry.listeners) {
      listener()
    }
  }
}
export function acceptDesktopPresentationFrame(
  scope: string,
  frame: RuntimeMobileSessionTabsResult,
  source = 'snapshot'
): void {
  const key = `${scope}\0${source}\0${frame.worktree}`
  const current = new Set<string>()
  for (const tab of frame.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    const id =
      scope === LOCAL_STRUCTURED_SESSION_OWNER
        ? tab.ptyId
        : tab.status === 'ready'
          ? toRemoteRuntimePtyId(tab.terminal, scope)
          : null
    if (!id) {
      continue
    }
    current.add(id)
    const entry = entryFor(id)
    entry.members.add(key)
    if (entry.incarnationId !== tab.incarnationId) {
      retractDesktopPresentation(id)
    }
    if (tab.presentation && tab.presentation.incarnationId === tab.incarnationId) {
      acceptDesktopPresentation(id, tab.presentation, key)
    } else {
      retractDesktopPresentation(id, key)
    }
    entry.incarnationId = tab.incarnationId
  }
  const previous = scopes.get(key)
  if (current.size) {
    scopes.set(key, current)
  } else {
    scopes.delete(key)
  }
  for (const id of previous ?? []) {
    if (current.has(id)) {
      continue
    }
    const entry = entries.get(id)
    entry?.members.delete(key)
    retractDesktopPresentation(id, entry?.members.size ? key : undefined)
  }
}
export function retractDesktopPresentations(
  scope: string,
  worktree?: string,
  source = 'snapshot'
): void {
  const prefix = `${scope}\0${source}\0`
  for (const key of worktree ? [prefix + worktree] : scopes.keys()) {
    if (!key.startsWith(prefix)) {
      continue
    }
    const ids = scopes.get(key)
    scopes.delete(key)
    for (const id of ids ?? []) {
      entries.get(id)?.members.delete(key)
      retractDesktopPresentation(id, key)
    }
  }
}
