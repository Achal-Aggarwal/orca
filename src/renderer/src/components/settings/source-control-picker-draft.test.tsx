// @vitest-environment happy-dom
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import './__fixtures__/settings-persistence-test-fixture'
import { getDefaultSourceControlAiSettings } from '../../../../shared/source-control-ai'
import type {
  SourceControlAiSettings,
  RepoSourceControlAiOverrides
} from '../../../../shared/source-control-ai-types'
import { useSourceControlActionRecipeDraftState } from './source-control-action-recipe-draft-state'
import { useRepositorySourceControlAiGlobalUx } from './repository-source-control-ai-global-ux'
import { AgentLaunchSetupPanel } from '../agent/AgentLaunchSetupPanel'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { TooltipProvider } from '../ui/tooltip'

const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ kind: 'terminal', agent: 'codex' }],
  surfaces: ['terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  arguments: '--search',
  catalog: { origin: 'unknown' }
}
const recipe = {
  agentId: 'codex',
  agentArgs: '--verbose',
  launchPreferences: { agentId: 'codex', model: 'opaque-alias' }
} as const
const source = { ...getDefaultSourceControlAiSettings(), actions: { fixChecks: recipe } }

function Editor({
  value,
  onUse,
  onSave,
  onDiscard
}: {
  value: AgentPickerDraft
  onUse: (draft: AgentPickerDraft) => void
  onSave: () => void
  onDiscard: () => void
}) {
  return (
    <TooltipProvider>
      <AgentLaunchSetupPanel
        entry={entry}
        initial={value}
        mode="save"
        onUse={onUse}
        key={JSON.stringify(value)}
      />
      <button onClick={onSave}>Save recipe</button>
      <button onClick={onDiscard}>Discard recipe</button>
    </TooltipProvider>
  )
}

function Global({ saved }: { saved: { value: SourceControlAiSettings } }) {
  const [config, setConfig] = useState(saved.value)
  const draft = useSourceControlActionRecipeDraftState({
    config,
    writeConfig: async (patch) => {
      saved.value = {
        ...saved.value,
        ...(typeof patch === 'function' ? patch(saved.value) : patch)
      }
      setConfig(saved.value)
    }
  })
  const value = draft.actionRecipeDraftState.values.fixChecks
  const { agentId: _binding, ...choices } = value.launchPreferences ?? {}
  return (
    <Editor
      value={{ agent: 'codex', surface: 'terminal', choices, arguments: value.agentArgs }}
      onUse={(setup) => {
        draft.onActionLaunchPreferencesChange('fixChecks', {
          agentId: setup.agent,
          ...setup.choices
        })
        draft.onActionAgentArgsChange('fixChecks', setup.arguments ?? undefined)
      }}
      onSave={() => void draft.saveActionTemplateDraft('fixChecks')}
      onDiscard={() => draft.discardActionTemplateDraft('fixChecks')}
    />
  )
}

function Repo({ saved }: { saved: { value: RepoSourceControlAiOverrides } }) {
  const [persisted, setPersisted] = useState(saved.value)
  const draft = useRepositorySourceControlAiGlobalUx({
    repoId: 'repo',
    persistedRepoAi: persisted,
    settings: null,
    source,
    updateRepo: async (_id, update) => {
      saved.value = update.sourceControlAi ?? {}
      setPersisted(saved.value)
      return true
    }
  })
  const value = draft.displayRepoAi.actionOverrides?.fixChecks
  const { agentId: _binding, ...choices } = value?.launchPreferences ?? {}
  return (
    <Editor
      value={{ agent: 'codex', surface: 'terminal', choices, arguments: value?.agentArgs }}
      onUse={(setup) => {
        draft.updateActionLaunchPreferences('fixChecks', { agentId: setup.agent, ...setup.choices })
        draft.updateActionAgentArgs('fixChecks', setup.arguments === null ? '' : setup.arguments)
      }}
      onSave={() => void draft.saveActionRecipeText('fixChecks')}
      onDiscard={() => draft.discardActionRecipeText('fixChecks')}
    />
  )
}

it.each(['global', 'repo'])(
  '%s: keeps setup edits draft-only, discards them, and saves Arguments Reset without losing an opaque model',
  async (scope) => {
    const global = { value: source }
    const repo = { value: { actionOverrides: { fixChecks: recipe } } }
    const current = () =>
      scope === 'global' ? global.value.actions?.fixChecks : repo.value.actionOverrides?.fixChecks
    render(scope === 'global' ? <Global saved={global} /> : <Repo saved={repo} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
      target: { value: '--quiet' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(current()?.agentArgs).toBe('--verbose')
    fireEvent.click(screen.getByRole('button', { name: 'Discard recipe' }))
    expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--verbose')
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(current()?.agentArgs).toBe('--verbose')
    fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    await waitFor(() => expect(current()?.agentArgs).toBeUndefined())
    expect(current()?.launchPreferences?.model).toBe('opaque-alias')
  }
)
