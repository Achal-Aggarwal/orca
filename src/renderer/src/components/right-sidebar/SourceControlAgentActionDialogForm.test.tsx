import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlAgentActionDialogForm } from './SourceControlAgentActionDialogForm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({
    value,
    allowBlankTerminal,
    surfaceRows
  }: {
    value: string | null
    allowBlankTerminal?: boolean
    surfaceRows?: { setup?: unknown; onSetup?: unknown }
  }) =>
    React.createElement('div', {
      'data-agent-value': value ?? '',
      'data-allow-blank': String(allowBlankTerminal === true),
      'data-agent-setup': JSON.stringify(surfaceRows?.setup),
      'data-can-configure': String(typeof surfaceRows?.onSetup === 'function')
    })
}))

vi.mock('@/components/ui/dialog', () => ({
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children)
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children, value }: { children?: ReactNode; value: string }) =>
    React.createElement('div', { 'data-select-item': value }, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))

vi.mock('../source-control/SourceControlActionVariableChips', () => ({
  SourceControlActionVariableChips: ({
    variablePreviews
  }: {
    variablePreviews?: Partial<Record<string, string>>
  }) =>
    React.createElement('div', {
      'data-variable-previews': JSON.stringify(variablePreviews ?? {})
    })
}))

function renderForm(
  overrides: Partial<React.ComponentProps<typeof SourceControlAgentActionDialogForm>> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(SourceControlAgentActionDialogForm, {
      actionId: 'resolveConflicts',
      baseCommandInput: 'Resolve the merge conflicts reported for this pull request.',
      agentScopeNote: null,
      agentOptions: [],
      selectedAgent: 'codex',
      hasEnabledAgents: true,
      detecting: false,
      surfaceRows: {
        model: { state: 'loading', placeholderCount: 0 },
        selection: { ready: true, cli: false },
        onPick: () => {},
        onSetup: () => {},
        setup: { agent: 'codex', surface: 'terminal', choices: {}, arguments: '--search' }
      },
      statusCopy: null,
      agentArgs: '',
      agentArgsApply: true,
      recipe: {
        agentId: overrides.selectedAgent ?? 'codex',
        commandInputTemplate: overrides.commandTemplate ?? '{basePrompt}',
        ...(overrides.agentArgs !== undefined ? { agentArgs: overrides.agentArgs } : {})
      },
      commandTemplate: '{basePrompt}',
      savedCommandInputTemplate: '{basePrompt}',
      saveLaunchRecipe: true,
      saveTargetValue: 'global',
      saveTargets: [
        { value: 'none', label: "Don't save" },
        { value: 'global', label: 'All repositories' }
      ],
      settings: null,
      repo: null,
      canSaveAgentDefault: true,
      deliveryPlan: { status: 'idle' },
      canStart: true,
      isStarting: false,
      startLabel: 'Start agent',
      onAgentPick: () => {},
      onAgentArgsChange: () => {},
      onCommandTemplateChange: () => {},
      onSaveLaunchRecipeChange: () => {},
      onSaveAgentDefaultChange: () => {},
      onCancel: () => {},
      onStart: () => {},
      ...overrides
    })
  )
}

function settingsWithSavedGlobalRecipe(): GlobalSettings {
  return {
    sourceControlAi: {
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customAgentCommand: '',
      instructionsByOperation: {},
      actions: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}'
        }
      }
    }
  } as unknown as GlobalSettings
}

const repoWithoutSavedRecipe = {
  id: 'repo-1',
  sourceControlAi: { enabled: true }
} satisfies Pick<Repo, 'id' | 'sourceControlAi'>

describe('SourceControlAgentActionDialogForm', () => {
  it('passes the base prompt preview to the variable chip hover content', () => {
    const markup = renderForm()

    expect(markup).toContain('Resolve the merge conflicts reported for this pull request.')
  })

  it('names the saved choice on chat and terminal launches alike', () => {
    const recipe = {
      agentId: 'codex' as const,
      launchPreferences: {
        agentId: 'codex' as const,
        model: 'saved',
        permissionMode: 'ask' as const
      }
    }
    expect(renderForm({ recipe, agentArgsApply: true })).toContain(
      'Older servers use their own permission settings.'
    )
    expect(
      renderForm({
        recipe: { ...recipe, launchPreferences: { agentId: 'codex', model: 'saved' } },
        agentArgsApply: false
      })
    ).toContain('Model from Settings: saved')
    expect(
      renderForm({
        selectedAgent: 'antigravity',
        recipe: {
          agentId: 'antigravity',
          launchPreferences: { agentId: 'antigravity', permissionMode: 'ask' }
        }
      })
    ).toContain('Applies to chats only')
  })

  it('offers agents only, since an action cannot start without one', () => {
    expect(renderForm()).toContain('data-allow-blank="false"')
  })

  it('checks already-saved copy against the selected save target', () => {
    const settings = settingsWithSavedGlobalRecipe()
    const saveTargets = [
      { value: 'none', label: "Don't save" },
      { value: 'repo', label: 'This repository' },
      { value: 'global', label: 'All repositories' }
    ]

    const globalMarkup = renderForm({
      settings,
      recipe: { agentId: 'codex', commandInputTemplate: '{basePrompt}' },
      repo: repoWithoutSavedRecipe,
      saveTargets,
      saveTargetValue: 'global'
    })
    const repoMarkup = renderForm({
      settings,
      repo: repoWithoutSavedRecipe,
      saveTargets,
      saveTargetValue: 'repo'
    })
    const clearedArgsMarkup = renderForm({ settings, agentArgs: '' })

    expect(globalMarkup).toContain('Launch recipe already saved')
    expect(globalMarkup).not.toContain('Save &amp; start agent')
    expect(repoMarkup).not.toContain('Launch recipe already saved')
    expect(repoMarkup).toContain('Save &amp; start agent')
    expect(clearedArgsMarkup).not.toContain('Launch recipe already saved')
    expect(clearedArgsMarkup).toContain('Save &amp; start agent')
  })

  it('surfaces a diverging repo override alongside the save controls', () => {
    const markup = renderForm({
      agentScopeNote: { effectiveAgentLabel: 'Codex', globalAgentLabel: 'Claude' }
    })

    expect(markup).toContain('overrides your global default (Claude)')
    expect(markup).toContain('currently runs Codex')
  })

  it('omits the scope note when there is no diverging repo override', () => {
    const markup = renderForm({ agentScopeNote: null })

    expect(markup).not.toContain('overrides your global default')
  })

  it('omits the scope note when the save controls are hidden', () => {
    const markup = renderForm({
      agentScopeNote: { effectiveAgentLabel: 'Codex', globalAgentLabel: 'Claude' },
      canSaveAgentDefault: false
    })

    expect(markup).not.toContain('overrides your global default')
  })
})

it.each([true, false])(
  'passes setup editing to the shared picker with Arguments applicability %s',
  (agentArgsApply) => {
    const markup = renderForm({ agentArgsApply })
    expect(markup).toContain('data-can-configure="true"')
    expect(markup).toContain('--search')
    expect(markup).not.toContain('source-control-agent-cli-args')
  }
)
