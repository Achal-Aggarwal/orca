import { buildAgentResumeStartupPlan } from '../../../../shared/tui-agent-resume-startup'
import { join } from 'node:path'
import type { ResumeSpawnArgs } from './saved-resume-admission'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { getManagedDataAccountService } from '../../../managed-data-accounts/service'
import { getSharedClient } from '../../../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'

export async function savedOpenCodeSessionPresence(
  args: ResumeSpawnArgs,
  source: SleepingAgentSessionRecord | undefined
) {
  const signal = AbortSignal.timeout(1000)
  const { launchAgent: agent, resumeProviderSession: session, launchConfig, env = {} } = args
  const original = source?.launchConfig
  const accountId = original?.agentEnv.ORCA_DATA_ACCOUNT_ID
  if (
    !source ||
    !agent ||
    !['opencode', 'opencode2'].includes(agent) ||
    !session ||
    source.connectionId ||
    source.agent !== agent ||
    !agentProviderSessionsEqual(agent, source.providerSession, session) ||
    !accountId ||
    !original ||
    !launchConfig
  ) {
    return 'unavailable'
  }
  const standard = agent === 'opencode' ? 'opencode' : 'opencode2 --standalone'
  if (
    (original.agentCommand ?? standard) !== standard ||
    original.agentArgs ||
    (launchConfig.agentCommand ?? standard) !== standard ||
    launchConfig.agentArgs ||
    launchConfig.agentEnv.ORCA_DATA_ACCOUNT_ID !== accountId
  ) {
    return 'unavailable'
  }
  const knownCommand = (['posix', 'powershell', 'cmd'] as const).some(
    (shell) =>
      buildAgentResumeStartupPlan({
        agent: source.agent,
        providerSession: session,
        cmdOverrides: {},
        platform: process.platform,
        shell,
        agentCommand: standard,
        launchCwd: args.cwd
      })?.launchCommand === args.command
  )
  if (!knownCommand) {
    return 'unavailable'
  }
  try {
    const selected = getManagedDataAccountService().environmentForAccount('opencode', accountId)
    const expected = {
      ...selected,
      ORCA_DATA_ACCOUNT_ID: accountId,
      ORCA_DATA_ACCOUNT_DATA_HOME: selected.XDG_DATA_HOME,
      ORCA_DATA_ACCOUNT_STATE_HOME: selected.XDG_STATE_HOME,
      ORCA_DATA_ACCOUNT_PROVIDER: 'opencode'
    }
    const keys = Object.keys(expected)
    if (
      args.envToDelete?.some((key) => keys.includes(key)) ||
      Object.entries(expected).some(([key, value]) => env[key] !== undefined && env[key] !== value)
    ) {
      return 'unavailable'
    }
    const requested = env.ORCA_DATA_ACCOUNT_ID === accountId
    const applied = Object.entries(expected)
      .filter(([key]) => key !== 'ORCA_DATA_ACCOUNT_ID')
      .every(([key, value]) => env[key] === value)
    if (!requested && !applied) {
      return 'unavailable'
    }
    return await waitForPromiseWithSignal(
      getSharedClient().readSessionPresence(
        { root: join(selected.XDG_DATA_HOME, 'opencode'), sessionId: session.id },
        signal
      ),
      signal
    )
  } catch {
    return 'unavailable'
  }
}
