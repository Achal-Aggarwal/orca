import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { RpcClient } from '../../mobile/src/transport/rpc-client'
import type { RpcResponse } from '../../mobile/src/transport/types'
import { launchAgentWithPrompt } from '../../mobile/src/session/pr-ai-triage-launch'
import { AgentLaunchReplay } from './rpc-contract/agent-launch-params'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

vi.mock('../../mobile/src/platform/random-v4-uuid', () => ({
  randomV4Uuid: () => randomUUID()
}))

it('carries the selected raw group and typed choices through the phone request to host compilation', async () => {
  for (const agentArgs of [
    undefined,
    '',
    null,
    '--verbose',
    '--effort low --dangerously-skip-permissions'
  ]) {
    const ownChoice = agentArgs?.includes('--effort')
    const settings = {
      agentPermissionDefault: 'own' as const,
      sourceControlAi: {
        actions: {
          fixChecks: {
            agentId: 'claude' as const,
            surface: 'terminal' as const,
            launchPreferences: {
              agentId: 'claude' as const,
              model: 'opus',
              options: { effort: 'high' },
              permissionMode: 'ask' as const
            }
          }
        }
      }
    }
    const repo = {
      id: 'repo',
      sourceControlAi: {
        actionOverrides: {
          fixChecks: {
            ...(agentArgs !== undefined ? { agentArgs } : {}),
            ...(ownChoice
              ? {
                  launchPreferences: {
                    agentId: 'claude',
                    options: { effort: 'high' },
                    permissionMode: 'ask'
                  }
                }
              : {})
          }
        }
      }
    }
    const ok = (result: unknown): RpcResponse => ({
      id: 'x',
      ok: true,
      result,
      _meta: { runtimeId: 'r' }
    })
    const sendRequest = vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'settings.get') {
        return ok({ settings })
      }
      if (method === 'repo.list') {
        return ok({ repos: [repo] })
      }
      if (method === 'preflight.detectAgents') {
        return ok(['claude'])
      }
      if (method === 'agent.launchReplay') {
        return ok({
          outcome: { kind: 'terminal', handle: 'term' },
          worktreeId: 'repo::/w',
          receipt: {
            mode: 'terminal',
            preferred: 'terminal',
            reason: 'user_default',
            detail: 'Started a terminal agent.'
          },
          prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })
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
    expect(
      await launchAgentWithPrompt({
        client,
        hostCapabilities: [
          'agent.launch.v2',
          'agent.launch.replay.v1',
          'agent.launch.replay-required.v1',
          'agent.launch.chat-options.v1',
          'agent.launch.surface.v1'
        ],
        worktreeId: 'repo::/w',
        actionId: 'fixChecks',
        prompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).toEqual({ kind: 'sent' })
    const request = sendRequest.mock.calls.find(([method]) => method === 'agent.launchReplay')
    const params = AgentLaunchReplay.parse(request?.[1])
    if (agentArgs === undefined) {
      expect(params).not.toHaveProperty('agentArgs')
    } else {
      expect(params.agentArgs).toBe(agentArgs ?? '')
    }
    expect(params.chatOptions).toEqual(
      agentArgs === undefined
        ? { model: 'opus', effort: 'high', permissionMode: 'ask' }
        : ownChoice
          ? { effort: 'high', permissionMode: 'ask' }
          : { permissionMode: 'ask' }
    )
    const launch = resolveAgentLaunchCommand(
      resolveAgentStartupPlanInputs({
        agent: params.agent,
        settings: { ...settings, agentDefaultArgs: { claude: '--debug' } },
        platform: 'linux',
        isRemote: false,
        shell: 'posix',
        agentArgs: params.agentArgs,
        sessionOptions: params.chatOptions
      })
    )
    expect(launch.ok).toBe(true)
    if (!launch.ok) {
      throw new Error(launch.error)
    }
    expect(launch.command).toBe(
      agentArgs === undefined
        ? "claude '--debug' '--model' 'opus' '--effort' 'high' '--permission-mode' 'default'"
        : ownChoice
          ? "claude '--dangerously-skip-permissions' '--effort' 'high'"
          : `claude${agentArgs ? " '--verbose'" : ''} '--permission-mode' 'default'`
    )
  }
})
