// Include unlisted current models without inferred capabilities, for both live and resting reads.

import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { AgentModelCatalogLiveListing } from '../agent-model-catalog/agent-model-catalog-entry'
import { decodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import { finishedListingIds } from '../../../shared/structured-agent-session-options'
import { savedEffectiveServiceTier } from '../../../shared/structured-agent-session-effective-tier'
import { independentAgentModelCatalog } from '../agent-model-catalog/agent-model-catalog-discovery'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export type StructuredAgentSessionOptionProjection = {
  models: readonly AgentSessionModelOption[]
  options: Readonly<Record<string, string>>
}

export type StructuredAgentSessionLiveOptions = AgentSessionOptionsResult & {
  catalogListing?: AgentModelCatalogLiveListing
  /** Exact requested identity proven equivalent to current.model by this child's response. */
  confirmedModelSelection?: string
}

export type StructuredAgentSessionRestingOptions = Pick<
  AgentSessionOptionsResult,
  'models' | 'listedModelIds' | 'fastModeSupport' | 'current'
> & {
  inventory: AgentSessionModelCatalogResult
  fallback: AgentSessionOptionsResult['models']
}

export function structuredAgentSessionOptionModels<TModel extends AgentSessionModelOption>(
  catalog: readonly TModel[],
  current: string | undefined,
  row: (unlisted: AgentSessionModelOption) => TModel
): TModel[] {
  const models = [...catalog]
  if (current && !models.some((entry) => entry.id === current)) {
    models.push(
      row({ id: current, label: current, isDefault: false, efforts: [], effortsKnown: false })
    )
  }
  return models
}

/** Use seeds only for unknown listings; installed rows are authoritative. */
export function structuredAgentSessionCapabilityView(
  installed:
    | {
        models: readonly AgentSessionModelOption[]
        fastModeSupport?: AgentSessionOptionsResult['fastModeSupport']
      }
    | { origin: 'unknown' },
  current: string | undefined,
  fallback: readonly AgentSessionModelOption[] = [],
  restriction?: AgentSessionOptionsResult['fastModeSupport']
) {
  const inventory = 'models' in installed ? installed : { models: fallback }
  const models = structuredAgentSessionOptionModels(inventory.models, current, (row) => row)
  const support = models.find((row) => row.id === current)?.supportsFastMode
  return {
    models,
    fastModeSupport:
      restriction ??
      (support !== undefined
        ? { supported: support, ...(support ? {} : { reason: 'model-not-supported' as const }) }
        : inventory.fastModeSupport),
    listedServiceTiers: inventory.models.flatMap(
      (row) => row.serviceTiers?.map((tier) => tier.value) ?? []
    )
  }
}

/** Whether a client accepts answers without a model. */
export type StructuredAgentSessionOptionsReader = { readsWithoutModel: boolean }

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
