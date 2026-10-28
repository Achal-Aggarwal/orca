import { describe, expect, it } from 'vitest'
import {
  mockCreateTab,
  queuedStartups,
  store,
  mockToastError,
  mockCreateWebRuntimeSessionTerminal,
  mockIsWebRuntimeSessionActive
} from './launch-agent-in-new-tab-test-fixture'

describe('picker window launch contract', () => {
  it.each(['claude', 'codex'] as const)(
    'preserves %s permission and model intent through the actual picker-to-terminal compiler',
    async (agent) => {
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const {
        agentPickerChoiceSeeds,
        agentPickerDraft,
        editAgentPickerArguments,
        agentPickerLaunchInputs
      } = await import('../../../shared/agent-launch-picker')
      const settings = {
        agentPermissionDefault: 'ask' as const,
        agentDefaultArgs: { [agent]: '--add-dir docs' },
        nativeChatSessionOptions: { [agent]: { model: 'remembered-chat-model' } }
      }
      Object.assign(store.settings, settings)
      const entry = {
        agent,
        label: agent,
        rows: [{ agent, kind: 'terminal' as const }],
        surfaces: ['terminal' as const, 'chat' as const],
        defaultSurface: 'terminal' as const,
        catalog: { origin: 'unknown' as const },
        ...agentPickerChoiceSeeds(agent, settings)
      }
      const launch = (input = {}) => {
        mockCreateTab.mockClear()
        launchAgentInNewTab({
          requestId: 'picker-contract',
          agent,
          worktreeId: 'wt-1',
          requestedSurface: 'terminal',
          ...input
        })
        return queuedStartups()[0]?.command
      }
      const ordinary = launch()
      expect(launch(agentPickerLaunchInputs(agentPickerDraft(entry), entry))).toBe(ordinary)
      for (const text of ['--add-dir src', '', '--unknown opaque --add-dir src']) {
        const command = launch(
          agentPickerLaunchInputs(editAgentPickerArguments(agentPickerDraft(entry), text), entry)
        )
        expect(command).toContain(
          agent === 'claude'
            ? "'--permission-mode' 'default'"
            : "'-a' 'on-request' '-s' 'read-only'"
        )
        expect(command).not.toContain('remembered-chat-model')
        expect(command).not.toContain('docs')
      }
      const raw =
        agent === 'claude'
          ? '--permission-mode plan --add-dir src'
          : '-a never -s danger-full-access --add-dir src'
      const command = launch(
        agentPickerLaunchInputs(editAgentPickerArguments(agentPickerDraft(entry), raw), entry)
      )
      expect(command).toContain(agent === 'claude' ? "'--permission-mode' 'plan'" : "'-a' 'never'")
      expect(command).not.toContain(
        agent === 'claude' ? "'--permission-mode' 'default'" : "'-a' 'on-request'"
      )
    }
  )

  it.each(['local', 'ssh', 'paired', 'older-host'] as const)(
    'keeps ordinary and configured-default launch input/failure contracts on %s',
    async (target) => {
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const { agentPickerChoiceSeeds, agentPickerDraft, agentPickerLaunchInputs } =
        await import('../../../shared/agent-launch-picker')
      Object.assign(store.settings, { agentDefaultArgs: { claude: '--add-dir docs' } })
      if (target === 'ssh') {
        store.repos[0].connectionId = 'ssh-target-1'
      }
      if (target === 'paired' || target === 'older-host') {
        mockIsWebRuntimeSessionActive.mockReturnValue(true)
        store.settings.activeRuntimeEnvironmentId = 'web-runtime'
        Object.assign(store.repos[0], { executionHostId: 'runtime:web-runtime' })
        if (target === 'older-host') {
          mockCreateWebRuntimeSessionTerminal.mockResolvedValue({
            status: 'failed',
            message: 'Upgrade the remote Orca host before starting or resuming agent sessions.'
          })
        }
      }
      const entry = {
        agent: 'claude' as const,
        label: 'Claude',
        rows: [{ agent: 'claude' as const, kind: 'terminal' as const }],
        surfaces: ['terminal' as const],
        defaultSurface: 'terminal' as const,
        catalog: { origin: 'unknown' as const },
        ...agentPickerChoiceSeeds('claude', store.settings)
      }
      const perform = async (inputs = {}) => {
        mockCreateTab.mockClear()
        mockCreateWebRuntimeSessionTerminal.mockClear()
        mockToastError.mockClear()
        const result = launchAgentInNewTab({
          requestId: 'equivalence',
          agent: 'claude',
          worktreeId: 'wt-1',
          requestedSurface: 'terminal',
          ...inputs
        })
        await result?.terminalCompletion
        return {
          command: queuedStartups()[0]?.command,
          remote: mockCreateWebRuntimeSessionTerminal.mock.calls[0]?.[0],
          errors: mockToastError.mock.calls,
          surface: result?.surface
        }
      }
      const ordinary = await perform()
      const configured = await perform(agentPickerLaunchInputs(agentPickerDraft(entry), entry))
      expect(configured).toEqual(ordinary)
      expect(ordinary.surface?.kind).toBe(
        target === 'paired' || target === 'older-host' ? 'host-published' : 'local-terminal'
      )
      if (target === 'older-host') {
        expect(configured.errors).toHaveLength(1)
      }
    }
  )
})
