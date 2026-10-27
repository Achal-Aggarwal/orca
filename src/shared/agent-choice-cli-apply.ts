import type { AgentType } from './agent-status-types'
import type { AgentChoiceCliForm } from './agent-launch-choices'
import type { CatalogOptionApply } from './agent-session-option-catalog-types'
import { removeAgentArgOption } from './agent-session-option-agent-args'

type ChoiceCliArgumentForm = Exclude<AgentChoiceCliForm, { kind: 'recipe' }>

/** The declared grammar owns both forward spelling and conflicting argument removal. */
export function agentChoiceCliApply(
  agent: AgentType,
  forms: readonly [ChoiceCliArgumentForm, ...ChoiceCliArgumentForm[]],
  emitted: string
): CatalogOptionApply {
  const encoder = forms.find((form) => form.names.includes(emitted)) ?? forms[0]
  return {
    cli: forms,
    launchArgs: (value) =>
      encoder.kind === 'config'
        ? [emitted, `${encoder.key}=${String(value)}`]
        : [emitted, String(value)],
    removeAgentArgs: (tokens) =>
      forms.reduce(
        (kept, form) =>
          removeAgentArgOption(
            agent,
            kept,
            form.names,
            form.kind === 'config'
              ? (value) => value?.slice(0, value.indexOf('=')).trim() === form.key
              : undefined
          ),
        [...tokens]
      )
  }
}
