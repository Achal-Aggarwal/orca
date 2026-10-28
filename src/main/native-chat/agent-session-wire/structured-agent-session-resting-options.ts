import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { decodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import { finishedListingIds } from '../../../shared/structured-agent-session-options'
import { savedEffectiveServiceTier } from '../../../shared/structured-agent-session-effective-tier'
import { independentAgentModelCatalog } from '../agent-model-catalog/agent-model-catalog-discovery'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  structuredAgentSessionOptionModels,
  type StructuredAgentSessionOptionsReader,
  type StructuredAgentSessionRestingOptions
} from './structured-agent-session-option-models'

export async function readStructuredAgentSessionOptionsAtRest(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'agents' | 'modelCatalog'>,
  sessionId: string,
  reader: StructuredAgentSessionOptionsReader
): Promise<StructuredAgentSessionRestingOptions> {
  const record = deps.store.getConversation(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  const rules = deps.agents.definition(record.provider)?.restingOptions ?? null
  const readCatalog = async (
    inSessionWorkspace: boolean
  ): Promise<AgentSessionModelCatalogResult> =>
    (await deps.modelCatalog
      ?.read({
        agent: record.provider,
        sessionId,
        savedOnly: true,
        ...(!reader.readsWithoutModel ? { legacyOptionsDisplay: true as const } : {}),
        ...(inSessionWorkspace
          ? { inSessionWorkspace: true as const }
          : independentAgentModelCatalog(record.provider)
            ? { workspacePath: null }
            : {})
      })
      .catch(() => null)) ?? { origin: 'unknown' }
  const saved = record.options ?? {}
  const scoped = await readCatalog(true)
  const folderDefault =
    scoped.origin === 'unknown' ? undefined : scoped.models.find((entry) => entry.isDefault)
  // Older clients requiring a model retain the account default when the folder has none.
  const catalog =
    saved.model === undefined &&
    !folderDefault &&
    scoped.origin !== 'unknown' &&
    !reader.readsWithoutModel
      ? await readCatalog(false)
      : scoped
  const listed = catalog.origin === 'unknown' ? (rules?.fallbackModels() ?? null) : catalog.models
  const models = listed ?? []
  const proof = independentAgentModelCatalog(record.provider)
    ? await deps.modelCatalog
        ?.read({
          agent: record.provider,
          sessionId,
          savedOnly: true,
          verifiedOnly: true,
          inSessionWorkspace: true
        })
        .catch(() => null)
    : catalog
  const listedModelIds = proof ? finishedListingIds(proof) : undefined
  const defaultModels =
    independentAgentModelCatalog(record.provider) && reader.readsWithoutModel
      ? proof && proof.origin !== 'unknown'
        ? proof.models
        : []
      : models
  const fastMode =
    saved.fastMode === undefined
      ? null
      : decodeStructuredAgentSessionOptionValue('fastMode', saved.fastMode)
  // Only a real listing confirms account defaults; built-in defaults cannot override client state.
  const model =
    saved.model ??
    (catalog.origin === 'unknown' ? undefined : models.find((entry) => entry.isDefault)?.id)
  // Prefer saved effort, then live execution or the folder’s matching model default.
  const effort =
    saved.effort ??
    (rules?.effortDefaultsToModel || (saved.model === undefined && folderDefault)
      ? defaultModels.find((entry) => entry.id === model)?.defaultEffort
      : undefined)
  const defaulted = (['model', 'effort'] as const).filter(
    (key) => saved[key] === undefined && Boolean(key === 'model' ? model : effort)
  )
  const serviceTier = savedEffectiveServiceTier(saved, models)
  return {
    inventory: catalog,
    fallback: catalog.origin === 'unknown' ? (listed ?? []) : [],
    models: listed ? structuredAgentSessionOptionModels(listed, model, (row) => row) : [],
    ...(catalog.origin !== 'unknown' && catalog.fastModeSupport
      ? { fastModeSupport: catalog.fastModeSupport }
      : {}),
    ...(listedModelIds ? { listedModelIds } : {}),
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      defaulted
    }
  }
}
