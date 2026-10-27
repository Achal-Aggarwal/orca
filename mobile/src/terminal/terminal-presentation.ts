import { admitRemoteForegroundEvidence } from '../../../src/shared/remote-foreground-evidence-admission'
import type { RemoteForegroundEvidence } from '../../../src/shared/foreground-process-evidence'
import { z } from 'zod'
import { defineRpcOperation, runRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  isTerminalPresentationObservation,
  type TerminalPresentationObservation
} from '../../../src/shared/terminal-foreground-presentation'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'

type Entry = {
  value?: TerminalPresentationObservation
  sources: Set<string>
  listeners: Set<() => void>
  pending?: Promise<void>
  evidence?: RemoteForegroundEvidence
  generations?: Set<string>
}
const clients = new WeakMap<UnvalidatedRpcRequestPort, Map<string, Entry>>()
const feedMembers = new WeakMap<UnvalidatedRpcRequestPort, Map<string, Set<string>>>()
const inspectPresentation = defineRpcOperation({
  name: 'terminal.inspect-presentation',
  method: 'terminal.inspectProcess',
  acceptance: 'object-result-or-null',
  barrier: 'on-settle',
  read: rpcResultVariant(
    'presentation',
    z.object({
      process: z.object({
        foregroundProcessEvidence: z.unknown().optional(),
        presentation: z
          .custom<TerminalPresentationObservation>(isTerminalPresentationObservation)
          .optional()
      })
    })
  )
})
export function mobilePresentationEntry(
  client: UnvalidatedRpcRequestPort,
  terminal: string
): Entry {
  let entries = clients.get(client)
  if (!entries) {
    entries = new Map()
    clients.set(client, entries)
  }
  let entry = entries.get(terminal)
  if (!entry) {
    entry = { listeners: new Set(), sources: new Set() }
    entries.set(terminal, entry)
  }
  return entry
}
function notify(entry: Entry): void {
  for (const listener of entry.listeners) {
    listener()
  }
}
function accept(
  entry: Entry,
  value: TerminalPresentationObservation | undefined,
  source = ''
): void {
  if (!value) {
    return
  }
  if (entry.value?.incarnationId === value.incarnationId) {
    if (value.version < entry.value.version) {
      return
    }
    if (value.version === entry.value.version) {
      const visible = entry.sources.size > 0
      entry.sources.add(source)
      if (!visible) {
        notify(entry)
      }
      return
    }
  } else {
    entry.evidence = undefined
    entry.generations = undefined
    entry.pending = undefined
  }
  entry.sources = new Set([source])
  entry.value = value
  notify(entry)
}
export function mobilePresentationSnapshot(client: UnvalidatedRpcRequestPort, terminal: string) {
  const entry = mobilePresentationEntry(client, terminal)
  return entry.sources.size ? entry.value : undefined
}
export function subscribeMobilePresentation(
  client: UnvalidatedRpcRequestPort,
  terminal: string,
  listener: () => void
): () => void {
  const entry = mobilePresentationEntry(client, terminal)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    if (
      !entry.listeners.size &&
      ![...(feedMembers.get(client)?.values() ?? [])].some((members) => members.has(terminal))
    ) {
      clients.get(client)?.delete(terminal)
    }
  }
}
function retract(client: UnvalidatedRpcRequestPort, terminal: string, scope?: string): void {
  const entry = clients.get(client)?.get(terminal)
  if (!entry) {
    return
  }
  const visible = entry.sources.size > 0
  if (scope === undefined) {
    entry.sources.clear()
  } else {
    entry.sources.delete(scope)
  }
  if (!entry.sources.size) {
    entry.pending = undefined
    entry.value = undefined
    entry.evidence = undefined
    entry.generations = undefined
    if (!entry.listeners.size) {
      clients.get(client)?.delete(terminal)
    }
    if (visible) {
      notify(entry)
    }
  }
}
export function retractMobilePresentations(
  client: UnvalidatedRpcRequestPort,
  scope?: string
): void {
  const scopes = feedMembers.get(client)
  const members = scope === undefined ? clients.get(client)?.keys() : scopes?.get(scope)
  if (scope === undefined) {
    scopes?.clear()
  } else {
    scopes?.delete(scope)
  }
  for (const terminal of members ?? []) {
    retract(client, terminal, scope)
  }
}
export function acceptMobilePresentationFrame(
  client: UnvalidatedRpcRequestPort,
  tabs: readonly unknown[],
  scope: string
): void {
  let scopes = feedMembers.get(client)
  if (!scopes) {
    scopes = new Map()
    feedMembers.set(client, scopes)
  }
  const current = new Set<string>()
  for (const tab of tabs) {
    if (
      typeof tab !== 'object' ||
      !tab ||
      !('terminal' in tab) ||
      typeof tab.terminal !== 'string'
    ) {
      continue
    }
    current.add(tab.terminal)
    if (
      clients.get(client)?.get(tab.terminal)?.value?.incarnationId !==
      ('incarnationId' in tab ? tab.incarnationId : undefined)
    ) {
      retract(client, tab.terminal)
    }
    if (
      'presentation' in tab &&
      isTerminalPresentationObservation(tab.presentation) &&
      'incarnationId' in tab &&
      tab.incarnationId === tab.presentation.incarnationId
    ) {
      accept(mobilePresentationEntry(client, tab.terminal), tab.presentation, scope)
    } else {
      retract(client, tab.terminal, scope)
    }
  }
  const previous = scopes.get(scope)
  if (current.size) {
    scopes.set(scope, current)
  } else {
    scopes.delete(scope)
  }
  for (const terminal of previous ?? []) {
    if (current.has(terminal)) {
      continue
    }
    retract(client, terminal, scope)
    if (![...scopes.values()].some((members) => members.has(terminal))) {
      retract(client, terminal)
    }
  }
}
export function readMobilePresentation(
  client: UnvalidatedRpcRequestPort,
  terminal: string,
  expectedIncarnationId?: string | null
): Promise<void> {
  const entry = mobilePresentationEntry(client, terminal)
  if (entry.pending) {
    return entry.pending
  }
  const startedAt = performance.now()
  const incarnation = expectedIncarnationId ?? entry.value?.incarnationId ?? null
  const promise = runRpcOperation(client, inspectPresentation, {
    terminal,
    ...(incarnation ? { expectedIncarnationId: incarnation } : {})
  })
    .then((response) => {
      if (clients.get(client)?.get(terminal) !== entry || entry.pending !== promise) {
        return
      }
      const evidence = admitRemoteForegroundEvidence(response?.process.foregroundProcessEvidence, {
        expectedPtyId: terminal,
        expectedIncarnationId: incarnation,
        requestStartedAtMonotonic: startedAt,
        receivedAtMonotonic: performance.now(),
        lastAuthorityGeneration: entry.evidence?.authorityGeneration ?? null,
        lastObservationEpoch: entry.evidence?.observationEpoch ?? -1,
        knownAuthorityGenerations: entry.generations
      })
      if (!evidence) {
        return
      }
      entry.evidence = evidence
      ;(entry.generations ??= new Set()).add(evidence.authorityGeneration)
      accept(entry, response?.process.presentation)
    })
    .catch(() => {})
    .finally(() => {
      if (entry.pending === promise) {
        entry.pending = undefined
      }
    })
  entry.pending = promise
  return promise
}
