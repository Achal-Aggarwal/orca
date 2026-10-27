import { isTuiAgent } from './tui-agent-config'
import { reconcileAgentChoiceArgs } from './agent-choice-reconciliation'
import {
  SOURCE_CONTROL_LAUNCH_ACTION_IDS,
  type AiActionId,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from './source-control-ai-types'

type PermissionRecipe = Pick<SourceControlActionRecipe, 'agentId' | 'launchPreferences'> & {
  agentArgs?: string | null
}

/** Load keeps stored intent; a deliberate field commit may replace it with an exact typed recipe. */
export function liftActionPermissionArgs<T extends PermissionRecipe>(
  recipe: T,
  edited = false,
  actionId?: AiActionId
): T {
  if (actionId && !SOURCE_CONTROL_LAUNCH_ACTION_IDS.some((id) => id === actionId)) {
    return recipe
  }
  if (!isTuiAgent(recipe.agentId) || typeof recipe.agentArgs !== 'string') {
    return recipe
  }
  const previous = recipe.launchPreferences
  if (previous && previous.agentId !== recipe.agentId) {
    return recipe
  }
  const result = reconcileAgentChoiceArgs({
    agent: recipe.agentId,
    userArgs: recipe.agentArgs,
    choices: previous ?? {},
    mode: edited ? 'arguments-edit' : 'load',
    keys: new Set(['permissionMode', 'model', 'effort'])
  })
  return result.userArgs === recipe.agentArgs
    ? recipe
    : {
        ...recipe,
        agentArgs: result.userArgs,
        launchPreferences: { agentId: recipe.agentId, ...result.choices }
      }
}

/** Only the row's own concrete agent proves which CLI grammar its saved text uses. */
export function migrateActionPermissionArgs<
  T extends NonNullable<RepoSourceControlAiOverrides['actionOverrides']>
>(actions: T | undefined): T | undefined {
  if (!actions) {
    return actions
  }
  let next = actions
  for (const id of SOURCE_CONTROL_LAUNCH_ACTION_IDS) {
    const recipe = actions[id]
    if (!recipe) {
      continue
    }
    const lifted = liftActionPermissionArgs(recipe, false, id)
    if (lifted !== recipe) {
      next = { ...next, [id]: lifted }
    }
  }
  return next
}
