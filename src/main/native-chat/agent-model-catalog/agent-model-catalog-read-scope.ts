import { isNativeLocalLocation } from '../../../shared/execution-host'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { newChatCatalogKey } from './agent-model-catalog-prewarm'
import { catalogFolder, sessionWorkspacePath } from './agent-model-catalog-workspace'
import { resolveAgentModelCatalogScope } from './agent-model-catalog-scope'
import type { AgentModelCatalogReadRecords } from './agent-model-catalog-running-account'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogLookupDeps
} from './agent-model-catalog-service-contract'

export type AgentModelCatalogReadScope = AgentModelCatalogReadRecords &
  NonNullable<Awaited<ReturnType<typeof resolveAgentModelCatalogScope>>> & {
    workspacePath: string | null | undefined
    folder: string | undefined
    probeHome: AgentSessionAccountHome | null
  }

/** Resolve folder/invocation scope without acquiring a conversation. */
export async function resolveAgentModelCatalogReadScope(
  deps: AgentModelCatalogLookupDeps,
  params: AgentModelCatalogReadParams,
  { record, scoped, savedOnly }: AgentModelCatalogReadRecords
): Promise<AgentModelCatalogReadScope | null> {
  const workspacePath = params.inSessionWorkspace
    ? record
      ? await sessionWorkspacePath(deps, record)
      : null
    : params.workspacePath
  const folder = await catalogFolder(deps, params.agent, workspacePath, scoped)
  let fingerprint: string
  let probeHome: AgentSessionAccountHome | null
  if (scoped) {
    fingerprint = agentModelCatalogFingerprintForRecord(scoped, folder)
    // Native probes cannot list a WSL-pinned account.
    probeHome = isNativeLocalLocation(scoped.location) ? scoped.accountHome : null
  } else {
    const key = await newChatCatalogKey(deps, params.agent, folder)
    if (!key) {
      return null
    }
    fingerprint = key.fingerprint
    probeHome = key.accountHome
  }
  const scope = await resolveAgentModelCatalogScope(
    deps,
    { ...params, savedOnly },
    scoped,
    fingerprint,
    probeHome
  )
  if (!scope) {
    return null
  }
  return { record, scoped, savedOnly, workspacePath, folder, probeHome, ...scope }
}
