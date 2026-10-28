import { expect, it, vi, type Mock } from 'vitest'
import * as localCapabilities from '@/runtime/local-runtime-capabilities'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { detectProjectLaunchContext } from '../../../main/preflight/workspace-agent-detection'
import { directWorkItemCatalogFixture } from './launch-work-item-direct-catalog.test-fixture'
import { launchWorkItemDirect } from './launch-work-item-direct'

const probe = vi.hoisted(() => vi.fn())
vi.mock('../../../main/wsl/wsl-runner', () => ({ runWslProcess: probe }))
vi.mock('../../../main/preflight/agent-detection', async () => {
  const { detectWslCommandsOnPath } =
    await import('../../../main/ipc/preflight-wsl-agent-detection')
  return {
    detectInstalledAgentsWithShellPathHydration: async () => [
      ...(await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex']))
    ],
    refreshShellPathAndDetectAgents: vi.fn()
  }
})

export function directDiscoveryProbe(): Mock {
  return probe
}

export function registerDirectDiscoveryFailureTests({
  mocks,
  callRuntimeRpc,
  probe
}: {
  mocks: {
    getStore: () => Record<string, unknown>
    ensureDetectedAgents: Mock
    createWorktree: Mock
    activateAndRevealWorktree: Mock
    toastError: Mock
    openModalFallback: Mock
  }
  callRuntimeRpc: Mock
  probe: Mock
}): void {
  it.each(['blank', 'claude'] as const)(
    'completes the direct %s action with the admitted WSL context after optional probe failure',
    async (choice) => {
      const platform = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const catalog = directWorkItemCatalogFixture()
        const hostSettings = {
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        } as const
        const hostStore = {
          getRepos: () => catalog.repos,
          getProjects: () => catalog.endpointProjects,
          getRepo: () => catalog.repos[0],
          getSettings: () => hostSettings
        }
        vi.spyOn(localCapabilities, 'ensureLocalRuntimeCapabilities').mockResolvedValue(
          RUNTIME_CAPABILITIES
        )
        callRuntimeRpc.mockImplementation(() =>
          detectProjectLaunchContext(hostStore, catalog.repos[0])
        )
        probe.mockResolvedValue({
          environmentResolved: false,
          code: 0,
          stdout: '',
          timedOut: false
        })
        mocks.ensureDetectedAgents.mockResolvedValue([])
        mocks.getStore().settings = {
          ...hostSettings,
          defaultTuiAgent: choice,
          disabledTuiAgents: [],
          agentCmdOverrides: {}
        }
        mocks.getStore().readLocalAgentInventory = () => ({ ids: null, state: 'failed' })
        mocks.getStore().localDetectedAgentIdsByContext = {}
        const launch = await launchWorkItemDirect({
          repoId: 'repo-1',
          launchSource: 'task_page',
          openModalFallback: mocks.openModalFallback,
          ...(choice === 'claude' ? { agentOverride: choice, agentArgs: '--model sonnet' } : {}),
          item: {
            type: 'issue',
            number: 42,
            title: 'Fix',
            url: 'https://github.com/acme/repo/issues/42'
          }
        })
        expect(mocks.toastError.mock.calls).toEqual([])
        expect(launch).toBe(true)
        expect(mocks.createWorktree).toHaveBeenCalledOnce()
        expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
        const activation = mocks.activateAndRevealWorktree.mock.calls[0][1]
        if (choice === 'claude') {
          expect(activation.startup).toMatchObject({
            launchAgent: 'claude',
            launchConfig: { agentArgs: '--model sonnet' }
          })
          expect(activation.startup.command).toContain('claude')
          expect(activation.startup.command).toBe(
            "claude '--model' 'sonnet' --prefill 'https://github.com/acme/repo/issues/42'"
          )
        } else {
          expect(activation.startup).toBeUndefined()
        }
        expect(mocks.toastError).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(process, 'platform', { value: platform })
      }
    }
  )
}
