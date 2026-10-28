import { vi, type Mock } from 'vitest'

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
