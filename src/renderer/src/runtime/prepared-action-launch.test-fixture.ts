import { eraseRpcMethods } from '../../../main/runtime/rpc/core'
import { TERMINAL_LIFECYCLE_METHODS } from '../../../main/runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import { expect, vi } from 'vitest'
import { normalizeSourceControlAiActionDefaults } from '../../../shared/source-control-ai-actions'
import { sourceControlActionLaunchOptions } from '../../../shared/source-control-action-launch-preferences'
import { agentLaunchNeedsPreparedCommand } from '../../../shared/agent-launch-preferences'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../../shared/tui-agent-startup'
import { resolveAgentSessionOptionLaunch } from '../../../shared/agent-session-option-launch-legacy.test-fixture'
import {
  OrcaRuntimeWithResolveMobileSessionTerminalCommand,
  type MobileTerminalCommandOptions
} from '../../../main/runtime/terminal/launch/mobile-terminal-startup'

vi.mock('../../../main/runtime/terminal/launch/mobile-terminal-renderer-create', () => ({
  OrcaRuntimeWithRunCreateMobileSessionTerminal: class {}
}))

export function independentActionEffortPlan(agent: 'claude' | 'codex') {
  const recipe = normalizeSourceControlAiActionDefaults({
    fixChecks: {
      agentId: agent,
      launchPreferences: { agentId: agent, options: { effort: 'high' } }
    }
  })?.fixChecks
  expect(recipe?.launchPreferences).toEqual({
    agentId: agent,
    modelSelection: {
      base: 'default',
      options: { effort: { agentId: agent, value: 'high' } }
    }
  })
  const { sessionOptions } = sourceControlActionLaunchOptions(recipe ?? {}, agent)
  expect(sessionOptions).toEqual({ effort: 'high' })
  expect(resolveAgentSessionOptionLaunch(agent, sessionOptions)).toEqual({
    args: [],
    appliedValues: {}
  })
  const plan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent,
      settings: { agentPermissionDefault: 'own' },
      platform: 'linux',
      isRemote: true,
      shell: 'posix',
      agentArgs: '--verbose',
      sessionOptions
    }),
    agentEnv: { ACTION_PROFILE: 'captured' },
    prompt: 'Fix checks'
  })
  if (!plan) {
    throw new Error('Missing action startup plan')
  }
  expect(plan.sessionOptions).toEqual({ effort: 'high' })
  expect(plan.launchCommand).toBe(
    agent === 'claude'
      ? "claude '--verbose' '--effort' 'high' 'Fix checks'"
      : "codex '--verbose' '-c' 'model_reasoning_effort=high' 'Fix checks'"
  )
  expect(agentLaunchNeedsPreparedCommand(agent, plan.sessionOptions)).toBe(true)
  return plan
}

export async function consumeOldHostPreparedCommand(params: MobileTerminalCommandOptions) {
  const consume = Reflect.get(
    OrcaRuntimeWithResolveMobileSessionTerminalCommand.prototype,
    'resolveMobileSessionTerminalCommand'
  )
  if (typeof consume !== 'function' || !params.command) {
    throw new Error('Expected a complete prepared command')
  }
  return await consume.call({}, {}, params)
}

// The prepared handler matches the pinned host when resumeOrigin is absent.
export async function consumePreparedBackgroundCommand(
  params: unknown,
  createTerminal: ReturnType<typeof vi.fn>
) {
  const method = eraseRpcMethods(TERMINAL_LIFECYCLE_METHODS).find(
    (method) => method.name === 'terminal.create'
  )
  if (!method?.params) {
    throw new Error('Missing terminal.create method')
  }
  const parsed = method.params.parse(params)
  const dedupeTerminalCreate = vi.fn(async (_identity, worktree, _mutation, _reconcile, create) =>
    create(worktree, 'reserved-handle')
  )
  const result = await Reflect.apply(method.handler, undefined, [
    parsed,
    {
      runtime: { createTerminal, dedupeTerminalCreate },
      pairedDeviceId: 'paired-current',
      clientKind: 'runtime'
    }
  ])
  expect(dedupeTerminalCreate).toHaveBeenCalledExactlyOnceWith(
    'paired-current',
    'id:wt-1',
    undefined,
    false,
    expect.any(Function)
  )
  return result
}
