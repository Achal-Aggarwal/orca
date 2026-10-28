// @vitest-environment happy-dom

import React from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  SourceControlAgentActionDialog,
  type SourceControlAgentActionDialogProps
} from './SourceControlAgentActionDialog'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'
import { normalizeSourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import { projectSourceControlActionLaunch } from '../../../../shared/source-control-action-launch-preferences'
import { liftActionPermissionArgs } from '../../../../shared/source-control-action-permission-lift'
import { saveSourceControlAiActionRecipeForTarget } from './source-control/ai/recipe-persistence'
import type { Repo } from '../../../../shared/repo-types'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { clearHostAgentMenuSettingsForTests } from '../settings/use-host-agent-launch-preferences'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY as SURFACE } from '../../../../shared/agent-launch-runtime-capability'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT
} from '../../../../shared/protocol-version'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useSourceControlAgentActionDialog } from './useSourceControlAgentActionDialog'

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  clearHostAgentMenuSettingsForTests()
  useAppStore.setState(initialState, true)
  setLocalRuntimeCapabilitiesForTests(null)
})

function renderDialog(chat: boolean, capable = true, initialRecipe?: SourceControlActionRecipe) {
  const settings = { ...getDefaultSettings('/tmp/pr-3'), defaultTuiAgent: 'claude' as const }
  const launchPreferences = normalizeSourceControlActionRecipe(
    { launchPreferences: { agentId: 'codex', model: 'chosen' } },
    true
  )!.launchPreferences!
  settings.sourceControlAi!.actions = { resolveConflicts: { agentId: null, launchPreferences } }
  useAppStore.setState({
    settings: { ...settings, experimentalNativeChat: chat },
    detectedAgentIds: ['claude', 'codex'],
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
  })
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, ...(capable ? [SURFACE] : [])])
  const onStart = vi.fn().mockResolvedValue(true)
  const onSaveAgentDefault = vi.fn()
  const view = renderHook(() =>
    useSourceControlAgentActionDialog({
      open: true,
      initialRecipe,
      onOpenChange: () => {},
      actionId: 'resolveConflicts',
      title: '',
      description: '',
      baseCommandInput: 'fix',
      launchSource: 'source_control_recovery',
      savedAgentId: null,
      onStart,
      onSaveAgentDefault
    })
  )
  return { ...view, onStart, onSaveAgentDefault, launchPreferences }
}

it('starts and saves a live pick from the unified picker, keeping the agent-bound model', async () => {
  const { result, onStart, onSaveAgentDefault, launchPreferences } = renderDialog(true)
  await waitFor(() => expect(result.current.canStart).toBe(true))
  // An untouched default recipe stays the default and saves no surface of its own.
  expect(result.current.selectedAgent).toBe('claude')
  expect(result.current.recipe).toMatchObject({ agentId: null, launchPreferences })
  expect(result.current.agentArgsApply).toBe(false)

  act(() => result.current.surfaceRows.onPick('codex', 'terminal'))
  expect(result.current.recipe).toMatchObject({ agentId: 'codex', surface: 'terminal' })
  expect(result.current.recipe.launchPreferences).toEqual(launchPreferences)
  expect(result.current.surfaceRows.selection.cli).toBe(true)
  expect(result.current.agentArgsApply).toBe(true)
  await act(() => result.current.handleStart())

  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'codex',
      launchChoice: expect.objectContaining({
        route: 'terminal-tui',
        requestedSurface: 'terminal'
      })
    })
  )
  expect(onSaveAgentDefault).toHaveBeenCalledWith(
    { type: 'global' },
    'resolveConflicts',
    expect.objectContaining({ agentId: 'codex', surface: 'terminal' })
  )

  act(() => result.current.surfaceRows.onPick('claude', 'chat'))
  expect(result.current.recipe).toMatchObject({ agentId: 'claude', surface: 'chat' })
  expect(result.current.recipe.launchPreferences).toBeUndefined()
  expect(result.current.agentArgsApply).toBe(false)
})

it('saves no surface for a pick made when the picker offers no chats', async () => {
  const { result, onStart, onSaveAgentDefault } = renderDialog(false)
  await waitFor(() => expect(result.current.canStart).toBe(true))

  act(() => result.current.surfaceRows.onPick('codex', 'terminal'))
  await act(() => result.current.handleStart())

  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({ launchChoice: expect.objectContaining({ route: 'terminal-tui' }) })
  )
  const savedRecipe = onSaveAgentDefault.mock.calls[0]?.[2]
  expect(savedRecipe).toMatchObject({ agentId: 'codex' })
  expect(savedRecipe).not.toHaveProperty('surface')
})

it('leaves an untouched saved surface in the draft but omits it when saving to an older action host', async () => {
  const { result, onSaveAgentDefault } = renderDialog(true, false, {
    agentId: 'codex',
    surface: 'terminal'
  })
  await waitFor(() => expect(result.current.canStart).toBe(true))
  expect(result.current.recipe.surface).toBe('terminal')
  expect(result.current.agentArgsApply).toBe(true)
  act(() => result.current.onCommandTemplateChange('edited {basePrompt}'))
  await act(() => result.current.handleStart())
  const saved = onSaveAgentDefault.mock.calls[0]?.[2]
  expect(saved).not.toHaveProperty('surface')
  expect(saved).not.toHaveProperty('agentArgs')
  expect(result.current.recipe.surface).toBe('terminal')
})

it('allows replacing an unavailable saved agent without making it launchable', async () => {
  const f = renderDialog(false, true, { agentId: 'codex', agentArgs: '' })
  await act(async () =>
    useAppStore.setState({
      detectedAgentIds: ['claude'],
      localDetectedAgentIdsByContext: { host: ['claude'] }
    })
  )
  expect(f.result.current.surfaceRows.selection.ready).toBe(true)
  expect(f.result.current.canStart).toBe(false)
  expect(f.result.current.recipe.agentId).toBe('codex')
  expect(f.onStart).not.toHaveBeenCalled()
  act(() => f.result.current.surfaceRows.onPick('claude', 'terminal'))
  await waitFor(() => expect(f.result.current.canStart).toBe(true))
})

const hostRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: hostRpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
it.each(['codex', null] as const)(
  'uses the offered host identity for delivery and scope, preserving authored %s',
  async (agentId) => {
    const reply = Promise.withResolvers<{
      settings: ReturnType<typeof projectAgentLaunchSettings>
    }>()
    hostRpc.mockReturnValue(reply.promise)
    const settings = {
      ...getDefaultSettings('/tmp/host-action'),
      defaultTuiAgent: 'opencode' as const,
      disabledTuiAgents: ['codex' as const],
      experimentalNativeChat: false
    }
    const recipe = {
      agentId,
      surface: 'terminal' as const,
      agentArgs: '--model chosen',
      launchPreferences: { agentId: 'codex' as const, model: 'chosen' }
    }
    const repo: Repo = {
      ...TEST_REPO,
      executionHostId: 'runtime:alpha',
      sourceControlAi: {
        actionOverrides: {
          resolveConflicts: {
            agentId: 'codex' as const,
            launchPreferences: recipe.launchPreferences
          }
        }
      }
    }
    useAppStore.setState({
      settings,
      repos: [repo],
      worktreesByRepo: {
        [repo.id]: [makeWorktree({ id: 'wt', repoId: repo.id, hostId: 'runtime:alpha' })]
      },
      runtimeDetectedAgentIds: {
        [getRuntimeAgentInventoryKey('alpha', 'wt')]: ['claude', 'codex', 'opencode']
      },
      ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex', 'opencode']),
      refreshRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex', 'opencode'])
    })
    const onStart = vi.fn().mockResolvedValue(true)
    const onSaveAgentDefault = vi.fn()
    const view = renderHook(() =>
      useSourceControlAgentActionDialog({
        open: true,
        initialRecipe: recipe,
        onOpenChange: vi.fn(),
        actionId: 'resolveConflicts',
        title: '',
        description: '',
        baseCommandInput: 'fix',
        launchSource: 'source_control_recovery',
        worktreeId: 'wt',
        repoId: repo.id,
        connectionId: null,
        onStart,
        onSaveAgentDefault
      })
    )
    expect(view.result.current.canStart).toBe(false)
    expect(view.result.current.saveTargetValue).toBe('repo')
    act(() => view.result.current.onSaveAgentDefaultChange('global'))
    await act(async () =>
      reply.resolve({
        settings: projectAgentLaunchSettings({
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['opencode', 'claude']
        })
      })
    )
    expect(view.result.current.surfaceRows.model).toMatchObject({
      state: 'settled',
      rows: [{ agent: 'codex', kind: 'terminal' }]
    })
    expect(view.result.current.selectedAgent).toBe('codex')
    expect(view.result.current.canStart).toBe(true)
    expect(view.result.current.saveTargetValue).toBe('global')
    expect(view.result.current.agentScopeNote).toBeNull()
    await act(() => view.result.current.handleStart())
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        agentArgs: '--dangerously-bypass-approvals-and-sandbox --model chosen',
        sessionOptions: { model: 'chosen' },
        agentLaunchPreferences: {
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['opencode', 'claude']
        }
      })
    )
    expect(onSaveAgentDefault).toHaveBeenCalledWith(
      { type: 'global' },
      'resolveConflicts',
      expect.objectContaining({ agentId, agentArgs: '--model chosen' })
    )
    expect(useAppStore.getState().settings).toBe(settings)
  }
)

type SaveAction = NonNullable<SourceControlAgentActionDialogProps['onSaveAgentDefault']>

function mountSourceDialog(
  global: SourceControlActionRecipe,
  own: SourceControlActionRecipe,
  save?: SaveAction,
  onStart = vi.fn().mockResolvedValue(true)
) {
  const settings = {
    ...getDefaultSettings('/tmp/fc1-action'),
    defaultTuiAgent: 'claude' as const,
    experimentalNativeChat: true,
    agentPermissionDefault: 'own' as const
  }
  settings.sourceControlAi!.actions = { resolveConflicts: global }
  const repo = { ...TEST_REPO, sourceControlAi: { actionOverrides: { resolveConflicts: own } } }
  useAppStore.setState({
    settings,
    repos: [repo],
    detectedAgentIds: ['claude', 'codex'],
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
  })
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, SURFACE])
  const persist = vi.fn<SaveAction>(
    save ??
      (async (target, actionId, recipe) => {
        await saveSourceControlAiActionRecipeForTarget({
          getStoreState: useAppStore.getState,
          target,
          actionId,
          recipe,
          updateSettings: async (patch) => {
            useAppStore.setState((state) => ({ settings: { ...state.settings!, ...patch } }))
          },
          updateRepo: async (id, patch) => {
            useAppStore.setState((state) => ({
              repos: state.repos.map((row) => (row.id === id ? { ...row, ...patch } : row))
            }))
            return true
          }
        })
      })
  )
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    actionId: 'resolveConflicts' as const,
    title: 'Resolve',
    description: '',
    baseCommandInput: 'fix',
    launchSource: 'source_control_recovery' as const,
    repoId: repo.id,
    connectionId: null,
    onStart,
    onSaveAgentDefault: persist
  }
  const mount = () =>
    render(<SourceControlAgentActionDialog {...props} />, { wrapper: TooltipProvider })
  return { view: mount(), mount, persist, onStart, props, repo }
}

async function pickDialogAgent(label: string, terminal: boolean) {
  await waitFor(() =>
    expect(screen.getAllByRole('combobox')[0].hasAttribute('disabled')).toBe(false)
  )
  fireEvent.click(screen.getAllByRole('combobox')[0])
  if (terminal) {
    fireEvent.click(await screen.findByRole('button', { name: `Start ${label} in a terminal` }))
  } else {
    const row = screen.getAllByRole('option').find((item) => item.textContent?.startsWith(label))
    if (!row) {
      throw new Error(`Missing agent row ${label}`)
    }
    fireEvent.click(row)
  }
}

function freshDialogRecipe(repoId: string) {
  const state = useAppStore.getState()
  return resolveSourceControlActionRecipe({
    settings: state.settings,
    repo: state.repos.find((row) => row.id === repoId),
    actionId: 'resolveConflicts'
  })
}

it.each([
  { saved: 'claude' as const, model: 'opus', terminal: true },
  { saved: null, model: undefined, terminal: false }
])(
  'keeps captured choices through actual same-agent picker dispatch, complete Save, Start and reopen (%s)',
  async ({ saved, model, terminal }) => {
    const global: SourceControlActionRecipe = {
      agentId: 'claude',
      agentArgs: '--verbose',
      launchPreferences: {
        agentId: 'claude',
        ...(model ? { model } : {}),
        options: { effort: 'high' }
      }
    }
    const own: SourceControlActionRecipe = {
      agentId: saved,
      launchPreferences: { agentId: 'claude', permissionMode: 'ask' }
    }
    const f = mountSourceDialog(global, own)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save & start agent' }).hasAttribute('disabled')
      ).toBe(false)
    )
    await pickDialogAgent('Claude', terminal)
    if (terminal) {
      expect(
        Reflect.get(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), 'value')
      ).toBe('--verbose')
    } else {
      expect(screen.queryByRole('textbox', { name: 'Extra CLI arguments' })).toBeNull()
    }
    expect(screen.getByText(/High/).textContent).toContain('High')
    if (model) {
      expect(screen.getByText(/High/).textContent).toContain('Opus')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
    await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
    const options = { ...(model ? { model } : {}), effort: 'high', permissionMode: 'ask' }
    expect(f.onStart).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', agentArgs: '--verbose', sessionOptions: options })
    )
    expect(f.persist).toHaveBeenCalledOnce()
    const savedRecipe = f.persist.mock.calls[0][2]
    expect(savedRecipe.launchPreferences).toEqual({
      agentId: 'claude',
      permissionMode: 'ask',
      modelSelection: {
        base: 'default',
        ...(model ? { model: { agentId: 'claude', value: model } } : {}),
        options: { effort: { agentId: 'claude', value: 'high' } }
      }
    })
    expect(
      projectSourceControlActionLaunch(freshDialogRecipe(f.repo.id), 'claude', {
        basePrompt: 'fix'
      })
    ).toMatchObject({ agentArgs: '--verbose', sessionOptions: options })
    f.view.unmount()
    const reopened = f.mount()
    expect(screen.getByText(/High/).textContent).toContain('High')
    reopened.unmount()
  }
)

it('distinguishes masked eligibility from owning reset and uses the captured parent through Save/Start', async () => {
  const global: SourceControlActionRecipe = {
    agentId: 'codex',
    agentArgs: '',
    launchPreferences: {
      agentId: 'codex',
      permissionMode: 'own',
      modelSelection: {
        base: 'default',
        model: { agentId: 'codex', value: 'o3' }
      }
    }
  }
  const own: SourceControlActionRecipe = {
    agentId: 'claude',
    launchPreferences: {
      agentId: 'claude',
      permissionMode: 'ask',
      modelSelection: {
        base: 'inherit',
        model: { agentId: 'claude', value: 'opus' }
      }
    }
  }
  const f = mountSourceDialog(global, own)
  const captured = resolveSourceControlActionRecipe({
    settings: useAppStore.getState().settings,
    repo: f.repo,
    actionId: 'resolveConflicts'
  })
  expect(
    projectSourceControlActionLaunch(captured, 'codex', {
      basePrompt: 'fix'
    }).sessionOptions
  ).toBeUndefined()
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save & start agent' }).hasAttribute('disabled')
    ).toBe(false)
  )
  act(() =>
    useAppStore.setState((state) => ({
      settings: {
        ...state.settings!,
        sourceControlAi: {
          ...state.settings!.sourceControlAi!,
          actions: {
            resolveConflicts: { ...global, launchPreferences: { agentId: 'codex', model: 'later' } }
          }
        }
      }
    }))
  )
  await pickDialogAgent('Codex', true)
  expect(screen.getByText(/Model from Settings: o3/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
  await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
  expect(f.onStart).toHaveBeenCalledWith(
    expect.objectContaining({ agent: 'codex', agentArgs: '', sessionOptions: { model: 'o3' } })
  )
  expect(f.persist.mock.calls[0][2]).toMatchObject({
    agentId: 'codex',
    agentArgs: '',
    launchPreferences: {
      agentId: 'codex',
      modelSelection: {
        base: 'default',
        model: { agentId: 'codex', value: 'o3' }
      }
    }
  })
  expect(f.persist.mock.calls[0][2].launchPreferences).toEqual({
    agentId: 'codex',
    modelSelection: { base: 'default', model: { agentId: 'codex', value: 'o3' } }
  })
  expect(f.persist.mock.calls[0][2]).not.toHaveProperty('resolvedChoiceSources')
  expect(
    projectSourceControlActionLaunch(freshDialogRecipe(f.repo.id), 'codex', { basePrompt: 'fix' })
      .sessionOptions
  ).toEqual({ model: 'o3' })
  await pickDialogAgent('Claude', false)
  await pickDialogAgent('Codex', true)
  expect(screen.queryByText(/Opus/)).toBeNull()
  f.view.unmount()
  const reopened = f.mount()
  expect(screen.getByText(/Model from Settings: o3/)).toBeDefined()
  reopened.unmount()
  useAppStore.setState((state) => ({
    repos: state.repos.map((row) =>
      row.id === f.repo.id
        ? {
            ...row,
            sourceControlAi: { actionOverrides: { resolveConflicts: { agentId: 'codex' } } }
          }
        : row
    )
  }))
  const fresh = f.mount()
  expect(screen.getByText(/Model from Settings: later/)).toBeDefined()
  fresh.unmount()
})

it('retains newly eligible literal syntax, demotes obsolete syntax once and does not restore it after switching back', async () => {
  const global = liftActionPermissionArgs({
    agentId: 'claude' as const,
    agentArgs: '--model opus --effort high --verbose'
  })
  const f = mountSourceDialog(global, {
    agentId: 'codex',
    launchPreferences: { agentId: 'codex', permissionMode: 'ask' }
  })
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save & start agent' }).hasAttribute('disabled')
    ).toBe(false)
  )
  await pickDialogAgent('Claude', true)
  expect(Reflect.get(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), 'value')).toBe(
    '--verbose'
  )
  expect(screen.getByText(/Opus/).textContent).toContain('High')
  fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
  await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
  expect(f.onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'claude',
      agentArgs: '--verbose',
      sessionOptions: { model: 'opus', effort: 'high' }
    })
  )
  const saved = f.persist.mock.calls[0][2]
  expect(saved.argumentChoices).toEqual(global.argumentChoices)
  expect(saved.launchPreferences).toBeUndefined()
  await pickDialogAgent('Codex', true)
  const text = screen.getByRole('textbox', { name: 'Extra CLI arguments' })
  expect(Reflect.get(text, 'value')).toBe('--model opus  --effort high --verbose')
  await pickDialogAgent('Claude', true)
  expect(screen.queryByText(/Model from Settings/)).toBeNull()
  expect(Reflect.get(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), 'value')).toBe(
    '--model opus  --effort high --verbose'
  )
})

it('keeps an owned empty-Args default barrier and submitted choices across failed Save, newer edits and Discard', async () => {
  const done = Promise.withResolvers<void>()
  const save = vi.fn<SaveAction>(() => done.promise)
  const f = mountSourceDialog(
    { agentId: 'codex', launchPreferences: { agentId: 'codex', model: 'o3' } },
    {
      agentId: 'claude',
      agentArgs: '',
      launchPreferences: {
        agentId: 'claude',
        modelSelection: { base: 'inherit', model: { agentId: 'claude', value: null } }
      }
    },
    save
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save & start agent' }).hasAttribute('disabled')
    ).toBe(false)
  )
  await pickDialogAgent('Codex', true)
  expect(screen.queryByText(/Model from Settings/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
  await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
  expect(f.onStart.mock.calls[0][0]).toMatchObject({
    agent: 'codex',
    agentArgs: '',
    commandInput: 'fix'
  })
  expect(f.onStart.mock.calls[0][0].sessionOptions).toBeUndefined()
  fireEvent.change(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), {
    target: { value: '--newer' }
  })
  await act(async () => done.reject(new Error('write failed')))
  expect(Reflect.get(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), 'value')).toBe(
    '--newer'
  )
  expect(save.mock.calls[0][2].agentArgs).toBe('')
  expect(f.onStart).toHaveBeenCalledOnce()
  expect(useAppStore.getState().repos[0].sourceControlAi).toEqual(f.repo.sourceControlAi)
  expect(freshDialogRecipe(f.repo.id).agentId).toBe('claude')
  f.view.unmount()
  const fresh = f.mount()
  await pickDialogAgent('Claude', true)
  expect(Reflect.get(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), 'value')).toBe(
    ''
  )
  fresh.unmount()
})
