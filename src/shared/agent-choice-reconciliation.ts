import { analyzeAgentChoiceArgs } from './agent-choice-args'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import { findCatalogModel } from './agent-session-option-catalog'
import {
  normalizeAgentModelOptionChoices,
  type AgentChoicePatch,
  type AgentDedicatedChoices
} from './agent-launch-choices'
import { agentPermissionChoices } from './tui-agent-permission-choice'
import type { TuiAgent } from './tui-agent'

export type AgentChoiceArgsInput = {
  agent: TuiAgent
  userArgs: string
  choices: AgentDedicatedChoices
  mode: 'load' | 'arguments-edit' | 'choice-edit'
  keys: ReadonlySet<string>
  patch?: AgentChoicePatch
}

export function reconcileAgentChoiceArgs(input: AgentChoiceArgsInput): {
  userArgs: string
  choices: AgentDedicatedChoices
} {
  const { agent, userArgs, keys, mode, patch } = input
  const analysis = analyzeAgentChoiceArgs(agent, userArgs)
  const choices = { ...input.choices, options: { ...input.choices.options } }
  const read = (key: string) =>
    key === 'model'
      ? choices.model
      : key === 'permissionMode'
        ? choices.permissionMode
        : choices.options[key]
  const write = (key: string, value: string | null) => {
    if (key === 'model') {
      if (value !== choices.model) {
        const independent = getAgentSessionOptionLaunchCatalog(agent)?.unknownModelOptions ?? []
        choices.options = Object.fromEntries(
          Object.entries(choices.options).filter(([id]) =>
            independent.some((option) => option.id === id && option.apply.launchArgs)
          )
        )
      }
      choices.model = value ?? undefined
    } else if (key === 'permissionMode') {
      choices.permissionMode = agentPermissionChoices(agent).find((choice) => choice === value)
    } else if (value === null) {
      delete choices.options[key]
    } else {
      choices.options[key] = value
    }
  }
  const counts = new Map<string, number>()
  analysis.occurrences.forEach((entry) => counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1))
  const selected = analysis.occurrences.filter((entry, _, all) => {
    if (!keys.has(entry.key) || !entry.lift || counts.get(entry.key) !== 1) {
      return false
    }
    if (entry.key !== 'model' && entry.key !== 'permissionMode') {
      const catalog = getAgentSessionOptionLaunchCatalog(agent)
      const model = all.find((other) => other.key === 'model' && other.lift)?.value ?? choices.model
      const option = (
        findCatalogModel(catalog ?? { models: [], modelApply: {} }, model ?? '')?.options ??
        catalog?.unknownModelOptions
      )?.find((option) => option.id === entry.key)
      if (
        option?.kind.type !== 'select' ||
        !option.apply.launchArgs ||
        !option.kind.choices.some((choice) => choice.value === entry.value)
      ) {
        return false
      }
    }
    if (
      !normalizeAgentModelOptionChoices({ model: entry.value }) ||
      entry.value.trim() !== entry.value
    ) {
      return false
    }
    const previous = read(entry.key)
    if (mode === 'choice-edit') {
      const next =
        entry.key === 'model'
          ? patch?.model
          : entry.key === 'permissionMode'
            ? patch?.permissionMode
            : patch?.options?.[entry.key]
      return (
        next !== undefined && ((next !== null && next !== 'default') || entry.value === previous)
      )
    }
    return mode === 'arguments-edit' || previous === undefined || previous === entry.value
  })
  const cut = analysis.cut(selected)
  if (cut !== null && mode !== 'choice-edit') {
    selected.forEach((entry) => write(entry.key, entry.value))
  }
  if (patch && mode === 'choice-edit') {
    if (patch.model !== undefined) {
      write('model', patch.model)
    }
    Object.entries(patch.options ?? {}).forEach(([key, value]) => write(key, value))
    if (patch.permissionMode !== undefined) {
      write('permissionMode', patch.permissionMode === 'default' ? null : patch.permissionMode)
    }
  }
  const normalized: AgentDedicatedChoices = {
    ...normalizeAgentModelOptionChoices(choices),
    ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {})
  }
  return { userArgs: cut ?? userArgs, choices: normalized }
}
