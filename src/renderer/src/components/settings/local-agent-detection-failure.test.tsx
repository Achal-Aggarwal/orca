// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react'
import { useState } from 'react'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import { useRepositorySourceControlAiGlobalUx } from './repository/source-control/repository-source-control-ai-global-ux'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { useAppStore } from '@/store'
import { NativeChatProvidersSetting } from './NativeChatProvidersSetting'
import { AgentLaunchSettingsCatalog } from './AgentLaunchSettingsCatalog'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'
import { useSourceControlActionAgent } from './use-source-control-action-agent'
import { RepositorySourceControlAiActionRows } from './repository/source-control/RepositorySourceControlAiActionRows'
import { getDefaultSourceControlAiSettings } from '../../../../shared/source-control-ai'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentStep } from '../onboarding/AgentStep'

vi.mock('@/lib/host-chat-program-acquisition', () => ({ useChatProgramFacts: () => {} }))
vi.mock('@/runtime/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: () => ({ kind: 'inactive' })
}))
vi.mock('@/lib/chat-provider-agents', () => ({
  chatProviderAgents: () => ['claude', 'codex', 'grok'],
  useHostStructuredAgentsVersion: () => 0
}))
vi.mock('./AntigravityChatSignInRow', () => ({ useAntigravityChatSignIn: () => ({ flow: null }) }))
const initial = useAppStore.getInitialState()
const detectAgents = vi.fn()
const refreshAgents = vi.fn()
beforeEach(() => {
  useAppStore.setState(initial, true)
  useAppStore.getState().clearLocalDetectedAgents()
  detectAgents.mockReset().mockRejectedValue(new Error('probe failed'))
  refreshAgents.mockReset().mockResolvedValue({ agents: ['claude'] })
  Object.assign(window, {
    api: {
      preflight: { detectAgents, refreshAgents },
      platform: { get: () => ({ platform: 'win32' }) }
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(initial, true)
})

it('shows a native failure and retries the native host even with a global WSL default', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    }
  })
  await useAppStore.getState().ensureNativeDetectedAgents()
  const view = render(
    <NativeChatProvidersSetting settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
  )
  expect(view.queryByText('Not installed')).toBeNull()
  expect(
    view.getAllByText(/Couldn't check which agents are installed on this computer/).length
  ).toBeGreaterThan(0)
  expect(view.getByRole('switch', { name: 'Open Claude as a chat' }).hasAttribute('disabled')).toBe(
    false
  )
  expect(
    view.getByRole('switch', { name: 'Open Codex as a chat' }).getAttribute('aria-checked')
  ).toBe('true')
  expect(view.getByRole('switch', { name: 'Open Codex as a chat' }).hasAttribute('disabled')).toBe(
    false
  )
  expect(view.getByRole('switch', { name: 'Open Grok as a chat' }).hasAttribute('disabled')).toBe(
    true
  )
  refreshAgents.mockRejectedValueOnce(new Error('retry still unavailable'))
  await act(async () => {
    fireEvent.click(view.getAllByRole('button', { name: 'Retry' })[0])
  })
  expect(view.getAllByText(/Couldn't check which agents/).length).toBeGreaterThan(0)
  expect(detectAgents).toHaveBeenCalledTimes(1)
  refreshAgents.mockClear()
  await act(async () => {
    fireEvent.click(view.getAllByRole('button', { name: 'Retry' })[0])
  })
  expect(refreshAgents).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(useAppStore.getState().readLocalAgentInventory(FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
    ids: ['claude'],
    state: 'successful'
  })
})

it.each([true, false])(
  'keeps an explicit provider choice %s operable after detection fails',
  async (choice) => {
    await useAppStore.getState().ensureNativeDetectedAgents()
    const settings = { ...getDefaultSettings('/tmp'), nativeChatProviders: { grok: choice } }
    Object.assign(window.api, { settings: { get: vi.fn(async () => settings) } })
    useAppStore.setState({ settings: null, hydrateRuntimeEnvironmentStatuses: vi.fn() })
    await useAppStore.getState().fetchSettings()
    expect(useAppStore.getState().settings?.nativeChatProviders).toEqual({ grok: choice })
    const update = vi.fn()
    const view = render(<NativeChatProvidersSetting settings={settings} updateSettings={update} />)
    const control = view.getByRole('switch', { name: 'Open Grok as a chat' })
    expect(control.getAttribute('aria-checked')).toBe(String(choice))
    expect(control.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(control)
    })
    expect(update).toHaveBeenCalledWith({ nativeChatProviders: { grok: !choice } })
  }
)

it('shows the catalog failure through the real hook while retaining installed agents', async () => {
  const mutate = vi.fn()
  detectAgents.mockResolvedValue(['claude'])
  await useAppStore.getState().ensureDetectedAgents()
  refreshAgents.mockRejectedValue(new Error('refresh failed'))
  const view = render(
    <AgentLaunchSettingsCatalog
      settings={projectAgentLaunchSettings(getDefaultSettings('/tmp'))}
      mutate={mutate}
      detectionTarget={{ kind: 'local' }}
      hostName={null}
      renderPermissions={() => null}
    />
  )
  await act(async () => {
    await useAppStore.getState().refreshDetectedAgents()
  })
  expect(view.getAllByText('Claude').length).toBeGreaterThan(0)
  const availability = view.getByRole('radiogroup', { name: 'Claude availability' })
  fireEvent.click(within(availability).getByRole('radio', { name: /Disabled/ }))
  expect(mutate).toHaveBeenCalled()
  expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(view.queryByText(/Check the host connection/)).toBeNull()
})

it('points a repair-required runtime at Project Runtime settings', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'wsl', distro: null }
    }
  })
  const view = render(
    <AgentLaunchSettingsCatalog
      settings={projectAgentLaunchSettings(getDefaultSettings('/tmp'))}
      mutate={vi.fn()}
      detectionTarget={{ kind: 'local' }}
      hostName={null}
      renderPermissions={() => null}
    />
  )
  await act(async () => {})
  expect(view.getByText(/Choose a WSL distro/)).toBeTruthy()
  expect(view.getByText(/Open project Settings → Project Runtime/)).toBeTruthy()
  expect(view.queryByText(/Try again/)).toBeNull()
})

it('settles Source Control arguments after an unknown native inventory fails', async () => {
  const { result } = renderHook(() => useSourceControlActionAgent(null, 'claude'))
  expect(result.current.status).toBe('pending')
  await act(async () => {
    await useAppStore.getState().ensureNativeDetectedAgents()
  })
  expect(result.current).toMatchObject({ status: 'ready', agent: null })
})

it('ends skill coverage loading with a failure instead of an empty inventory', async () => {
  const view = render(<OrchestrationSkillAgentCoverage skills={[]} sources={[]} loading={false} />)
  await act(async () => {})
  expect(view.queryByText(/Checking installed/)).toBeNull()
  expect(view.queryByText(/No agent CLIs/)).toBeNull()
  expect(view.getByText(/Couldn't check which agents/)).toBeTruthy()
})

it('does not claim an onboarding selection is absent after a failed check', async () => {
  await useAppStore.getState().ensureDetectedAgents()
  const view = render(
    <AgentStep
      selectedAgent="claude"
      onSelect={vi.fn()}
      detectedSet={new Set()}
      isDetecting={false}
    />
  )
  expect(view.queryByText(/No agents detected/)).toBeNull()
  expect(view.queryByText(/isn't on your PATH/)).toBeNull()
})

it('renders cold catalog failure, then Retry restores actual installed rows and controls', async () => {
  const mutate = vi.fn()
  const view = render(
    <TooltipProvider>
      <AgentLaunchSettingsCatalog
        settings={projectAgentLaunchSettings(getDefaultSettings('/tmp'))}
        mutate={mutate}
        detectionTarget={{ kind: 'local' }}
        hostName={null}
        renderPermissions={() => null}
      />
    </TooltipProvider>
  )
  await act(async () => {})
  expect(view.queryByText('Available to install')).toBeNull()
  expect(view.queryByText('Detecting agents…')).toBeNull()
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
  })
  expect(view.getByText('Installed')).toBeTruthy()
  expect(view.getByRole('radiogroup', { name: 'Claude availability' })).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('repository saved recipe permission editing settles after the real cold store rejection', async () => {
  useAppStore.setState({ repos: [TEST_REPO], settings: getDefaultSettings('/tmp') })
  let saved: RepoSourceControlAiOverrides = {
    actionOverrides: {
      fixChecks: {
        agentId: 'claude',
        surface: 'terminal',
        agentArgs: '--verbose'
      }
    }
  }
  function RepositoryRecipes() {
    const [persisted, setPersisted] = useState(saved)
    const draft = useRepositorySourceControlAiGlobalUx({
      repoId: TEST_REPO.id,
      persistedRepoAi: persisted,
      settings: getDefaultSettings('/tmp'),
      source: getDefaultSourceControlAiSettings(),
      updateRepo: async (_id, patch) => {
        saved = patch.sourceControlAi ?? {}
        setPersisted(saved)
        return true
      }
    })
    return (
      <RepositorySourceControlAiActionRows
        repoId={TEST_REPO.id}
        repoAi={draft.displayRepoAi}
        source={getDefaultSourceControlAiSettings()}
        defaultTuiAgent="claude"
        onActionModeChange={draft.updateActionMode}
        onActionAgentChange={draft.updateActionAgent}
        onActionLaunchPreferencesChange={draft.updateActionLaunchPreferences}
        onActionTemplateChange={draft.updateActionTemplate}
        onActionAgentArgsChange={draft.updateActionAgentArgs}
        onAppendVariable={draft.appendVariable}
        savingActionIds={draft.savingActionIds}
        actionDirtyById={draft.actionDirtyById}
        onActionDiscard={draft.discardActionRecipeText}
        onActionSave={draft.saveActionRecipeText}
      />
    )
  }
  const view = render(
    <TooltipProvider>
      <RepositoryRecipes />
    </TooltipProvider>
  )
  await act(async () => {})
  const row = view.container.querySelector('[data-settings-section$="source-control-ai-fixChecks"]')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing saved Checks row')
  }
  const editable = within(row).getByRole('button', { name: 'Claude permissions' })
  expect(editable.hasAttribute('disabled')).toBe(false)
  await userEvent.click(editable)
  const options = await view.findAllByRole('menuitemradio', { name: /Full access/ })
  const option = options.find((entry) => entry.getAttribute('aria-checked') === 'false')
  if (!option) {
    throw new Error('Missing explicit Full access choice')
  }
  await userEvent.click(option)
  await act(async () => {
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
  })
  expect(saved.actionOverrides?.fixChecks).toMatchObject({
    agentId: 'claude',
    surface: 'terminal',
    agentArgs: '--verbose',
    launchPreferences: { agentId: 'claude', permissionMode: 'full-access' }
  })
})

it('onboarding and setup checklist retain selection, continue and save after failed discovery', async () => {
  const { default: OnboardingFlow } = await import('../onboarding/OnboardingFlow')
  const { getDefaultOnboardingState } = await import('../../../../shared/onboarding-defaults')
  const { FeatureWallSetupChecklist } = await import('../feature-wall/FeatureWallSetupChecklist')
  const { FEATURE_WALL_SETUP_STEPS } = await import('../../../../shared/feature-wall-setup-steps')
  const update = vi.fn(async (patch) => {
    useAppStore.setState((s) => ({ settings: { ...s.settings!, ...patch } }))
    return true
  })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'claude' },
    updateSettings: update,
    refreshPreflightStatus: vi.fn(),
    checkLinearConnection: vi.fn()
  })
  refreshAgents.mockRejectedValue(new Error('probe still unavailable'))
  await useAppStore.getState().ensureDetectedAgents()
  const onboardingChanged = vi.fn()
  Object.assign(window.api, {
    onboarding: {
      update: vi.fn(async (patch: Parameters<typeof window.api.onboarding.update>[0]) => ({
        ...getDefaultOnboardingState(),
        ...patch,
        checklist: { ...getDefaultOnboardingState().checklist, ...patch.checklist }
      }))
    }
  })
  const view = render(
    <TooltipProvider>
      <OnboardingFlow
        onboarding={getDefaultOnboardingState()}
        onOnboardingChange={onboardingChanged}
      />
    </TooltipProvider>
  )
  await act(async () => {})
  expect(view.queryByText(/isn't on your PATH|No agents detected/)).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /^Codex/ }))
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: /Continue/ }))
  })
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ defaultTuiAgent: 'codex' }))
  expect(onboardingChanged).toHaveBeenCalledWith(expect.objectContaining({ lastCompletedStep: 1 }))
  cleanup()
  const step = FEATURE_WALL_SETUP_STEPS.find((entry) => entry.id === 'default-agent')!
  const checklist = render(
    <TooltipProvider>
      <FeatureWallSetupChecklist
        activeStep={step}
        progress={{
          ready: true,
          coreDoneCount: 0,
          coreTotal: 8,
          stepDone: {
            'default-agent': false,
            'add-two-repos': false,
            notifications: false,
            'two-worktrees': false,
            browser: false,
            'task-sources': false,
            'agent-capabilities': false,
            'setup-script': false
          }
        }}
        onSelectStep={vi.fn()}
        onOrchestrationSkillInstalledChange={vi.fn()}
        onBrowserUseSkillInstalledChange={vi.fn()}
      />
    </TooltipProvider>
  )
  await act(async () => {})
  expect(checklist.queryByText(/isn't on your PATH|No agents detected/)).toBeNull()
  await act(async () => {
    fireEvent.click(checklist.getByRole('button', { name: 'Claude', exact: true }))
  })
  expect(useAppStore.getState().settings?.defaultTuiAgent).toBe('claude')
})
