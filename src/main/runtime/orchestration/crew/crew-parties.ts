import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId,
  parseOrcaSessionAddress
} from '../../../../shared/orca-session-address'
import { isPublicOrchestrationAddress } from '../../../../shared/orchestration-agent-reference'
import { createCanonicalSessionPaneResolver } from '../structured-session-lineage'
import { createCanonicalOrcaSessionResolver } from '../canonical-orca-session-id'
import type { CrewReadDependencies } from './crew-read-model'

export type Party = AgentMessageSender['party'] & { paneKey: string | null }

export function createCrewPartyRegistry(deps: CrewReadDependencies) {
  const recordList = deps.records?.listRecords() ?? []
  const resolveRoot = createCanonicalOrcaSessionResolver({ listRecords: () => recordList })
  const rootCache = new Map<string, string>()
  const root = (id: string): string => {
    let value = rootCache.get(id)
    if (!value) {
      value = isOrcaSessionId(id) ? resolveRoot(id) : id
      rootCache.set(id, value)
    }
    return value
  }
  const canonicalPane = createCanonicalSessionPaneResolver(deps.records)
  const parties = new Map<string, Party>()
  const aliases = new Map<string, string>()
  const party = (
    session: string | null,
    storedHandle: string | null,
    pane: string | null,
    fallback?: string
  ): Party | undefined => {
    const sessionId = session ? root(session) : null
    const liveHandle = pane ? deps.handleForPane(pane) : null
    const handle =
      liveHandle ?? (storedHandle && deps.liveHandle(storedHandle) ? storedHandle : null)
    const publicHandle = handle?.startsWith('term_') ? handle : null
    const publicAddress =
      sessionId && isOrcaSessionId(sessionId)
        ? formatOrcaSessionAddress(sessionId)
        : ((publicHandle && aliases.get(publicHandle)) ?? publicHandle ?? fallback)
    if (!publicAddress || !isPublicOrchestrationAddress(publicAddress)) {
      return undefined
    }
    const existing = parties.get(publicAddress)
    const value = existing ?? {
      address: publicAddress,
      terminalHandle: publicHandle,
      orcaSessionId: parseOrcaSessionAddress(publicAddress),
      paneKey: sessionId ? canonicalPane(sessionId) : pane
    }
    parties.set(publicAddress, value)
    for (const alias of [
      publicAddress,
      storedHandle,
      handle,
      session && isOrcaSessionId(session) ? formatOrcaSessionAddress(session) : null
    ]) {
      if (alias) {
        aliases.set(alias, publicAddress)
      }
    }
    return value
  }
  return { parties, aliases, party }
}
