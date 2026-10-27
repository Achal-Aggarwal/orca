import { expect, it, vi } from 'vitest'
import { launchNewTabAgentThroughHost } from './new-tab-agent-host-launch'
import type { RpcClient } from '../transport/rpc-client'
import type { PendingSessionSelection } from './pending-session-selection'
import type { AgentPickerDraft } from '../../../src/shared/agent-launch-picker'

vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
const capabilities = [
  'agent.launch.v2',
  'agent.launch.replay-required.v1',
  'agent.launch.surface.v1'
]
function harness() {
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async () => ({
    id: 'x',
    ok: true,
    _meta: { runtimeId: 'runtime' },
    result: {
      worktreeId: 'workspace',
      outcome: { kind: 'terminal', handle: 'terminal' },
      receipt: {
        mode: 'terminal',
        preferred: 'terminal',
        reason: 'user_default',
        detail: 'Opened terminal.'
      }
    }
  }))
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const pendingSelectionRef: { current: PendingSessionSelection | null } = { current: null }
  return {
    client,
    hostCapabilities: capabilities,
    worktreeId: 'workspace',
    agent: 'codex' as const,
    options: undefined,
    lock: 'launch',
    pendingSelectionRef,
    fetchSessionTabs: vi.fn(async () => {}),
    getSessionTabs: () => [],
    showToast: vi.fn(),
    reportCreateFailure: vi.fn(),
    setCreateError: vi.fn(),
    sendRequest
  }
}
it('sends explicit setup through replay once, with nullable terminal Arguments only on the CLI', async () => {
  for (const surface of ['terminal', 'chat'] as const) {
    const args = harness()
    const pickerSetup: AgentPickerDraft = {
      agent: 'codex',
      surface,
      choices: { model: 'opaque-alias', options: { effort: 'low' }, permissionMode: 'ask' },
      arguments: null
    }
    expect(await launchNewTabAgentThroughHost({ ...args, options: { pickerSetup } })).toBe(true)
    expect(args.sendRequest).toHaveBeenCalledOnce()
    const [method, params] = args.sendRequest.mock.calls[0]
    expect(method).toBe('agent.launchReplay')
    expect(params).toMatchObject({
      surface,
      sessionOptions: { model: 'opaque-alias', effort: 'low', permissionMode: 'ask' }
    })
    if (surface === 'terminal') {
      expect(params).toHaveProperty('agentArgs', null)
    } else {
      expect(params).not.toHaveProperty('agentArgs')
    }
  }
})
it('preserves the old one-click fallback and never drops explicit choices into that fallback', async () => {
  const args = harness()
  expect(await launchNewTabAgentThroughHost({ ...args, hostCapabilities: [] })).toBe(false)
  expect(args.reportCreateFailure).not.toHaveBeenCalled()
  expect(
    await launchNewTabAgentThroughHost({
      ...args,
      hostCapabilities: [],
      options: { pickerSetup: { agent: 'codex', surface: 'terminal', choices: { model: 'alias' } } }
    })
  ).toBe(true)
  expect(args.sendRequest).not.toHaveBeenCalled()
  expect(args.reportCreateFailure).toHaveBeenCalledOnce()
})
