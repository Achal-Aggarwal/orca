// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { useAppStore } from '@/store'
import { NativeChatProvidersSetting } from './NativeChatProvidersSetting'
import { AgentLaunchSettingsCatalog } from './AgentLaunchSettingsCatalog'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'
import { useSourceControlActionAgent } from './use-source-control-action-agent'
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
vi.mock('./AgentCatalogRow', () => ({
  AgentCatalogRow: ({ label }: { label: string }) => <div>{label}</div>
}))
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
  expect(view.getByRole('switch', { name: 'Open Grok as a chat' }).hasAttribute('disabled')).toBe(
    true
  )
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
    useAppStore.setState({ settings })
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
  detectAgents.mockResolvedValue(['claude'])
  await useAppStore.getState().ensureDetectedAgents()
  refreshAgents.mockRejectedValue(new Error('refresh failed'))
  const view = render(
    <AgentLaunchSettingsCatalog
      settings={projectAgentLaunchSettings(getDefaultSettings('/tmp'))}
      mutate={vi.fn()}
      detectionTarget={{ kind: 'local' }}
      hostName={null}
      renderPermissions={() => null}
    />
  )
  await act(async () => {
    await useAppStore.getState().refreshDetectedAgents()
  })
  expect(view.getAllByText('Claude').length).toBeGreaterThan(0)
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
