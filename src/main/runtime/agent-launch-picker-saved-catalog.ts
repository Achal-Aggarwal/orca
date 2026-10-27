import type { AgentSessionModelCatalogResult } from '../../shared/agent-session-wire'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { agentModelCatalogResultFromEntry } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import {
  agentModelCatalogStore,
  type AgentModelCatalogStore
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'

export async function readAgentPickerSavedCatalog(
  agent: string,
  resolveAccountHome: () => Promise<AgentSessionAccountHome>,
  store: Pick<AgentModelCatalogStore, 'get'> = agentModelCatalogStore
): Promise<AgentSessionModelCatalogResult> {
  const home = await resolveAccountHome().catch(() => null)
  if (!home) {
    return { origin: 'unknown' }
  }
  const entry = store.get(
    agentModelCatalogFingerprint({ agent, accountHome: home, wslDistro: null })
  )
  return entry
    ? agentModelCatalogResultFromEntry(entry, false, false, false)
    : { origin: 'unknown' }
}
