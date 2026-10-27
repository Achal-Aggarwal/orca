import { expect, it, vi } from 'vitest'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { createWorktreeOnRuntimeHost } from './host-planned-agent-launch'
import type { ClientWorktreeCreateSettings } from './client-worktree-create-settings'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({ worktree: { id: 'created' } })),
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))

it('keeps the paired host planner and never sends the desktop fallback command to a capable host', async () => {
  await createWorktreeOnRuntimeHost(
    'paired',
    {
      repoId: 'repo',
      name: 'feature',
      startup: {
        command: '/desktop/codex --model desktop-only-alias',
        env: { DESKTOP_ONLY: 'true' }
      },
      options: { hostAgentLaunch: { agent: 'codex', prompt: 'Fix it' } }
    },
    { name: 'feature' },
    {} satisfies ClientWorktreeCreateSettings
  )
  expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalled()
  expect(callRuntimeRpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'paired' },
    'worktree.create',
    expect.objectContaining({ startupAgent: 'codex', startupPrompt: 'Fix it' }),
    expect.anything()
  )
  const params = vi.mocked(callRuntimeRpc).mock.calls[0]?.[2]
  expect(params).not.toHaveProperty('startupCommand')
  expect(params).not.toHaveProperty('startupEnv')
  expect(params).not.toHaveProperty('startupLaunchConfig')
})
