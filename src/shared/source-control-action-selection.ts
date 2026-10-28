import type {
  SourceControlActionLaunchPreferences,
  SourceControlActionRecipe
} from './source-control-ai-actions'
import {
  demoteActionArgumentChoices,
  readActionArgumentNode,
  transportActionArgumentChoices
} from './source-control-action-argument-choices'
import { readActionModelSelection } from './source-control-action-model-selection'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

type CurrentActionSource = {
  authoredAgentId: SourceControlActionRecipe['agentId']
  authoredPreferences: SourceControlActionLaunchPreferences | undefined
}

export type CurrentActionSelection = {
  current: Omit<
    SourceControlActionRecipe,
    'launchPreferences' | 'resolvedChoiceSources' | 'launchPreferencesYieldToAgentArgs'
  >
  source: CurrentActionSource &
    (
      | { scope: 'global' }
      | {
          scope: 'repo'
          parentPreferences: SourceControlActionLaunchPreferences | undefined
          ownsArgs: boolean
        }
    )
}

export type SelectedSourceControlActionRecipe = SourceControlActionRecipe & {
  resolvedChoiceSources: NonNullable<SourceControlActionRecipe['resolvedChoiceSources']> & {
    canonicalAgentId: TuiAgent | undefined
  }
}

/** Canonical entries have one authored source and no inferred parent. */
export function canonicalSourceControlActionSelection(
  recipe: SourceControlActionRecipe
): CurrentActionSelection {
  const {
    launchPreferences,
    resolvedChoiceSources: _sources,
    launchPreferencesYieldToAgentArgs: _yield,
    ...current
  } = recipe
  return {
    current,
    source: {
      scope: 'global',
      authoredAgentId: recipe.agentId,
      authoredPreferences: launchPreferences
    }
  }
}

export function selectSourceControlActionRecipe(
  selection: CurrentActionSelection
): SelectedSourceControlActionRecipe {
  const { current, source } = selection
  const own = source.authoredPreferences
  const parent = source.scope === 'repo' ? source.parentPreferences : undefined
  const ownsArgs = source.scope === 'repo' && source.ownsArgs
  const ownModel = readActionModelSelection(own)
  const parentModel = readActionModelSelection(parent)
  const model =
    ownsArgs || ownModel?.base === 'default'
      ? ownModel
      : ownModel
        ? {
            base: 'inherit' as const,
            model: ownModel.model ?? parentModel?.model,
            options: { ...parentModel?.options, ...ownModel.options }
          }
        : parentModel
  const permission =
    source.scope === 'repo'
      ? (own ?? (source.authoredAgentId === undefined ? parent : undefined))
      : own
  const preferences = source.scope === 'global' || ownsArgs ? own : (own ?? parent)
  return {
    ...current,
    ...(preferences ? { launchPreferences: preferences } : {}),
    resolvedChoiceSources: {
      model: source.scope === 'global' ? ownModel : model,
      permission,
      canonicalAgentId: permission?.agentId ?? preferences?.agentId ?? parent?.agentId,
      literalKeys:
        ownsArgs || ownModel?.base !== 'default' || source.scope === 'global'
          ? (current.argumentChoices?.nodes ?? []).flatMap((node) => {
              const key = readActionArgumentNode(
                current.argumentChoices!.syntaxAgent,
                node.text
              )?.key
              return key ? [key] : []
            })
          : []
    }
  }
}

/** Read-only recipe adapters admit canonical data once; mutable invocations retain their inputs. */
export function sourceControlActionRecipeEntry(
  recipe: SourceControlActionRecipe
): SelectedSourceControlActionRecipe {
  return recipe.resolvedChoiceSources
    ? {
        ...recipe,
        resolvedChoiceSources: {
          ...recipe.resolvedChoiceSources,
          canonicalAgentId: recipe.resolvedChoiceSources.canonicalAgentId
        }
      }
    : selectSourceControlActionRecipe(canonicalSourceControlActionSelection(recipe))
}

export function pickSourceControlActionAgent(
  selection: CurrentActionSelection,
  agent: TuiAgent,
  observedAgent: TuiAgent | null,
  surface: SourceControlActionRecipe['surface']
): CurrentActionSelection {
  const actual = isTuiAgent(selection.current.agentId) ? selection.current.agentId : observedAgent
  const same = actual === agent
  const preferences = selection.source.authoredPreferences
  const model = readActionModelSelection(preferences)
  const alreadyBound =
    preferences?.agentId === agent &&
    (!model?.model || model.model.agentId === agent) &&
    Object.values(model?.options ?? {}).every((entry) => entry.agentId === agent)
  const document = selection.current.argumentChoices
  const { surface: _surface, ...current } =
    !same && document && document.syntaxAgent !== agent
      ? demoteActionArgumentChoices(selection.current)
      : selection.current
  return {
    current: { ...current, agentId: agent, ...(surface ? { surface } : {}) },
    source: same
      ? selection.source
      : {
          ...selection.source,
          authoredAgentId: agent,
          authoredPreferences: alreadyBound ? preferences : undefined
        }
  }
}

export function editSourceControlActionArguments(
  selection: CurrentActionSelection,
  agentArgs: string
): CurrentActionSelection {
  return {
    ...selection,
    current: {
      ...selection.current,
      agentArgs,
      argumentChoices: transportActionArgumentChoices(selection.current, agentArgs)
    }
  }
}
