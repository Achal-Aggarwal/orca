import { agentPickerOptions, agentPickerModels } from './agent-launch-picker-catalog'
export {
  agentPickerOptions,
  agentPickerModels,
  agentPickerEntryOptions,
  agentPickerPermissions
} from './agent-launch-picker-catalog'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import { structuredLaunchSeedOptions } from './native-chat-session-option-defaults'
import { isAgentChatPermissionChoice } from './agent-chat-permission-mode'
import type { GlobalSettings } from './global-settings-types'
import type { AgentChoicePatch, AgentDedicatedChoices } from './agent-launch-choices'
import { reconcileAgentChoiceArgs } from './agent-choice-reconciliation'
import { resolveAgentChoiceLayers } from './agent-choice-layers'
import type { AgentSessionModelCatalogResult, AgentSessionModelOption } from './agent-session-wire'
import type { NewTabAgentMenuRow } from './agent-launch-picker-rows'
import type { TuiAgent } from './tui-agent'

export type AgentPickerSurface = 'chat' | 'terminal'
export type AgentPickerModel = AgentSessionModelOption & { isLegacy?: true; hidden?: true }
export type AgentPickerEntry = {
  agent: TuiAgent
  label: string
  aliases?: string[]
  rows: NewTabAgentMenuRow[]
  surfaces: AgentPickerSurface[]
  defaultSurface: AgentPickerSurface
  terminal: AgentDedicatedChoices
  structured: AgentDedicatedChoices
  arguments?: string | null
  catalog: AgentSessionModelCatalogResult
  defaultsPending?: boolean
}
export type AgentPickerDraft = {
  agent: TuiAgent
  surface: AgentPickerSurface
  choices: AgentDedicatedChoices
  arguments?: string | null
}
export type AgentPickerSetup = {
  entry: AgentPickerEntry
  model: AgentPickerModel
  choices: AgentDedicatedChoices
  label: string
}

export function agentPickerDraft(
  entry: AgentPickerEntry,
  surface = entry.defaultSurface
): AgentPickerDraft {
  return { agent: entry.agent, surface, choices: {}, arguments: undefined }
}

export function agentPickerEffectiveChoices(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): AgentDedicatedChoices {
  return resolveAgentChoiceLayers({
    agent: entry.agent,
    defaults: draft.surface === 'chat' ? entry.structured : entry.terminal,
    explicit: agentPickerLaunchChoices(draft).choices,
    userArgs:
      draft.surface === 'chat'
        ? undefined
        : draft.arguments === undefined
          ? entry.arguments
          : draft.arguments,
    argumentOwner: draft.arguments === undefined ? 'defaults' : 'launch'
  })
}

export function editAgentPickerDraft(
  draft: AgentPickerDraft,
  patch: AgentChoicePatch
): AgentPickerDraft {
  const keys = new Set([
    ...(patch.model !== undefined ? ['model'] : []),
    ...Object.keys(patch.options ?? {})
  ])
  const result = reconcileAgentChoiceArgs({
    agent: draft.agent,
    userArgs: '',
    choices: draft.choices,
    mode: 'choice-edit',
    keys,
    patch
  })
  // Terminal text can clear its own flags without making its other lifted values shared choices.
  const argumentsEdit =
    draft.arguments === undefined
      ? undefined
      : reconcileAgentChoiceArgs({
          agent: draft.agent,
          userArgs: draft.arguments ?? '',
          choices: agentPickerLaunchChoices({ ...draft, surface: 'terminal' }).choices,
          mode: 'choice-edit',
          keys,
          patch
        })
  return {
    ...draft,
    choices: result.choices,
    ...(argumentsEdit ? { arguments: argumentsEdit.userArgs || null } : {})
  }
}

export function editAgentPickerArguments(draft: AgentPickerDraft, text: string): AgentPickerDraft {
  return { ...draft, arguments: text || null }
}

function agentPickerLaunchChoices(draft: AgentPickerDraft) {
  if (draft.surface !== 'terminal' || draft.arguments === undefined) {
    return { choices: draft.choices, userArgs: draft.arguments }
  }
  const result = reconcileAgentChoiceArgs({
    agent: draft.agent,
    userArgs: draft.arguments ?? '',
    choices: draft.choices,
    mode: 'arguments-edit',
    keys: new Set([
      'model',
      'permissionMode',
      ...Object.keys(draft.choices.options ?? {}),
      ...agentPickerOptions(draft.agent, draft.choices.model, 'terminal').map((option) => option.id)
    ])
  })
  return result
}

export function agentPickerLaunchInputs(draft: AgentPickerDraft, entry?: AgentPickerEntry) {
  const { choices, userArgs } = agentPickerLaunchChoices(draft)
  // The existing dispatcher treats an Arguments override as the complete terminal profile.
  return {
    sessionOptions: agentPickerSessionOptions(choices),
    ...(draft.surface === 'terminal' && userArgs !== undefined
      ? {
          agentArgs: projectAgentLaunchProfile(draft.agent, undefined, {
            target: 'terminal',
            userArgs: userArgs ?? '',
            choices: {
              ...(entry?.terminal.permissionMode
                ? { permissionMode: entry.terminal.permissionMode }
                : {}),
              ...choices
            }
          }).args
        }
      : {})
  }
}

export function agentPickerButtonOrder(entry: AgentPickerEntry): AgentPickerSurface[] {
  return [
    ...entry.surfaces.filter((surface) => surface !== entry.defaultSurface),
    ...entry.surfaces.filter((surface) => surface === entry.defaultSurface)
  ]
}

const tokens = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/extra[\s-]*high/g, 'xhigh')
    .split(/[\s_\-/·]+/)
    .filter(Boolean)
const score = (word: string, values: readonly string[]): number =>
  values.includes(word)
    ? 2
    : word.length >= 2 && values.some((value) => value.startsWith(word))
      ? 1
      : 0

export function searchAgentPickerSetups(
  entries: readonly AgentPickerEntry[],
  query: string,
  limit = 8
): AgentPickerSetup[] {
  const words = tokens(query)
  if (!words.length) {
    return []
  }
  const matches: { setup: AgentPickerSetup; score: number }[] = []
  for (const entry of entries) {
    if (!entry.surfaces.length || entry.catalog.origin === 'unknown') {
      continue
    }
    const agentWords = tokens([entry.agent, entry.label, ...(entry.aliases ?? [])].join(' '))
    if (words.every((word) => score(word, agentWords))) {
      continue
    }
    for (const model of agentPickerModels(entry)) {
      if (model.isLegacy || model.hidden) {
        continue
      }
      const modelWords = tokens([model.id, model.label].join(' '))
      if (!words.some((word) => !score(word, agentWords) && score(word, modelWords))) {
        continue
      }
      const effortQuery = model.efforts.filter((effort) =>
        words.some(
          (word) =>
            !score(word, agentWords) &&
            !score(word, modelWords) &&
            score(word, tokens(`${effort.value} ${effort.label}`))
        )
      )
      const efforts = effortQuery.length ? effortQuery : [undefined]
      for (const effort of efforts) {
        const effortWords = effort ? tokens(`${effort.value} ${effort.label}`) : []
        const values = words.map((word) =>
          score(word, [...agentWords, ...modelWords, ...effortWords])
        )
        if (values.some((value) => value === 0)) {
          continue
        }
        const choices = resolveAgentChoiceLayers({
          agent: entry.agent,
          explicit: { model: model.id, ...(effort ? { options: { effort: effort.value } } : {}) },
          argumentOwner: 'defaults'
        })
        matches.push({
          setup: {
            entry,
            model,
            choices,
            label: [entry.label, model.label, effort?.label].filter(Boolean).join(' · ')
          },
          score: values.reduce((a, b) => a + b, 0)
        })
      }
    }
  }
  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((match) => match.setup)
}

export function agentPickerSessionOptions(choices: AgentDedicatedChoices): Record<string, string> {
  return {
    ...choices.options,
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {})
  }
}

export function agentPickerEntriesFromRows(
  rows: readonly NewTabAgentMenuRow[],
  detected: readonly TuiAgent[],
  seed: (agent: TuiAgent) => Pick<AgentPickerEntry, 'terminal' | 'structured' | 'arguments'>,
  label: (agent: TuiAgent) => string
): AgentPickerEntry[] {
  return [...new Set(rows.map((row) => row.agent))].map((agent) => {
    const own = rows.filter((row) => row.agent === agent)
    const chat = own.some((row) => row.kind === 'chat')
    return {
      agent,
      label: label(agent),
      rows: own,
      surfaces: [
        ...(chat ? ['chat' as const] : []),
        ...(detected.includes(agent) ? ['terminal' as const] : [])
      ],
      defaultSurface: chat ? 'chat' : 'terminal',
      ...seed(agent),
      catalog: { origin: 'unknown' }
    }
  })
}

export type AgentPickerDefaultSettings = Partial<
  Pick<
    GlobalSettings,
    | 'agentDefaultArgs'
    | 'agentPermissionDefault'
    | 'agentPermissionOverrides'
    | 'nativeChatSessionOptions'
    | 'nativeChatPermissionMode'
  >
>

export function agentPickerChoiceSeeds(
  agent: TuiAgent,
  settings: AgentPickerDefaultSettings | null | undefined
): Pick<AgentPickerEntry, 'terminal' | 'structured' | 'arguments'> {
  const profile = projectAgentLaunchProfile(agent, settings, { target: 'structured' })
  const { model, permissionMode, ...options } = structuredLaunchSeedOptions(settings, agent) ?? {}
  return {
    terminal: profile.choices,
    structured: {
      ...(model ? { model } : {}),
      options,
      ...(isAgentChatPermissionChoice(permissionMode) ? { permissionMode } : {})
    },
    arguments: profile.args
  }
}

export function agentPickerHydrationQueue(
  entries: readonly AgentPickerEntry[],
  selected: () => TuiAgent | undefined
): () => number | undefined {
  const pending = new Set(entries.flatMap((entry, index) => (entry.surfaces.length ? [index] : [])))
  return () => {
    const preferred = entries.findIndex((entry) => entry.agent === selected())
    const index = pending.has(preferred) ? preferred : pending.values().next().value
    if (index !== undefined) {
      pending.delete(index)
    }
    return index
  }
}
