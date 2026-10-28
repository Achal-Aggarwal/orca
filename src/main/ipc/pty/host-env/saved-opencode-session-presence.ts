import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { resolveUnixPaneShellPath, resolvePtyShellPath } from '../../../daemon/shell-ready'
import { buildAgentResumeStartupPlan } from '../../../../shared/tui-agent-resume-startup'
import { dropAgentResumeArgvFromCommand } from '../../../../shared/agent-resume-argv-drop'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../../../shared/setup-agent-sequencing'
import { tokenizeStartupCommand } from '../../../../shared/tui-agent-startup-shell'
import {
  getAgentLaunchExecutableName,
  getAgentLaunchCommandToken
} from '../../../../shared/agent-command-line-intent'
import type { ResumeSpawnArgs } from './saved-resume-admission'
import { getSharedClient } from '../../../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { buildInheritedLocalPtyEnvironment } from '../../../providers/local-pty-spawn-environment'
import { projectManagedDataAccountEnvironment } from '../../../managed-data-accounts/launch-environment'
import { captureLoginShellEnvironment } from '../../../startup/login-shell-environment'
import { probeOpenCodeLaunchCapabilities } from '../../../opencode/opencode-launch-capabilities'
import { withOpenCodeStandaloneServer } from '../../../opencode/opencode-private-server'
import { resolveOpenCodeSessionSource } from '../../../opencode/opencode-session-source'

export async function missingOpenCodeFreshLaunch(args: ResumeSpawnArgs) {
  const signal = AbortSignal.timeout(2500)
  const decide = async () => {
    const { launchAgent: agent, resumeProviderSession: session } = args
    if (
      (agent !== 'opencode' && agent !== 'opencode2') ||
      !session ||
      !/^[A-Za-z0-9_-]+$/.test(session.id)
    ) {
      return null
    }
    const recipe =
      args.launchConfig?.agentCommand ||
      (agent === 'opencode2' ? 'opencode2 --standalone' : 'opencode')
    if (!['opencode', 'opencode2'].includes(getAgentLaunchExecutableName(recipe))) {
      return null
    }
    if (!args.cwd || !isAbsolute(args.cwd)) {
      return null
    }
    const env = args.env ?? {}
    const sequenced = env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
    const command = sequenced || args.command
    if (!command) {
      return null
    }
    const shell = (['posix', 'powershell', 'cmd'] as const).find((shell) => {
      const expected = buildAgentResumeStartupPlan({
        agent,
        providerSession: session,
        cmdOverrides: {},
        platform: process.platform,
        shell,
        agentCommand: recipe,
        agentArgs: args.launchConfig?.agentArgs,
        launchCwd: args.cwd
      })?.launchCommand
      return (
        expected &&
        (command === expected || command === withOpenCodeStandaloneServer(expected, shell))
      )
    })
    if (!shell) {
      return null
    }
    const parsed = tokenizeStartupCommand(command, shell)
    const dropped = dropAgentResumeArgvFromCommand({ command, agent, providerSession: session })
    if (
      !parsed.ok ||
      parsed.tokens.some((token) => token === '--server' || token.startsWith('--server=')) ||
      dropped.status !== 'dropped'
    ) {
      return null
    }
    const script = env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]
    if (sequenced && script && !script.includes(command)) {
      return null
    }
    let projected = buildInheritedLocalPtyEnvironment(env, args.envToDelete)
    if (!args.assembledEnvironment) {
      projected = projectManagedDataAccountEnvironment(projected, {
        launchAgent: agent,
        launchCommand: command
      })
    }
    for (const key of args.envToDelete ?? []) {
      delete projected[key]
    }
    const captured = await captureLoginShellEnvironment({
      env: projected,
      cwd: args.cwd,
      startedAfter: Date.now(),
      shellOverride:
        process.platform === 'win32'
          ? args.shellOverride || resolvePtyShellPath(projected)
          : resolveUnixPaneShellPath(projected, args.shellOverride, undefined),
      resolveCommand: getAgentLaunchCommandToken(recipe),
      timeoutMs: 1000
    })
    if (
      captured.status !== 'captured' ||
      !captured.executablePath ||
      !isAbsolute(captured.executablePath) ||
      !captured.cwd ||
      !isAbsolute(captured.cwd)
    ) {
      return null
    }
    const executable = await open(captured.executablePath, 'r')
    try {
      const header = Buffer.alloc(4)
      await executable.read(header, 0, 4, 0)
      // Script wrappers can select another store after the shell; their source is unknown.
      if (
        ![
          '7f454c46',
          'cffaedfe',
          'cefaedfe',
          'feedfacf',
          'feedface',
          'cafebabe',
          'bebafeca'
        ].includes(header.toString('hex')) &&
        header.subarray(0, 2).toString() !== 'MZ'
      ) {
        return null
      }
    } finally {
      await executable.close()
    }
    const effective = { ...captured.env }
    // Orca's shell integration pins the selected account after the profile runs.
    if (
      projected.ORCA_DATA_ACCOUNT_PROVIDER === 'opencode' &&
      projected.ORCA_DATA_ACCOUNT_DATA_HOME
    ) {
      Object.assign(effective, {
        XDG_DATA_HOME: projected.ORCA_DATA_ACCOUNT_DATA_HOME,
        XDG_STATE_HOME: projected.ORCA_DATA_ACCOUNT_STATE_HOME,
        OPENCODE_DB: 'opencode.db'
      })
    }
    const capabilities = await probeOpenCodeLaunchCapabilities({
      command: recipe,
      agent,
      env: effective,
      cwd: captured.cwd,
      fresh: true,
      resolveExecutable: async () => captured.executablePath ?? null
    })
    if (!capabilities?.version || capabilities.pluginApi === 'unknown') {
      return null
    }
    const source = await resolveOpenCodeSessionSource({
      env: effective,
      cwd: captured.cwd,
      version: capabilities.version,
      api: capabilities.pluginApi,
      standalone: parsed.tokens.includes('--standalone'),
      sessionId: session.id,
      signal
    })
    const presence =
      typeof source === 'string'
        ? source
        : await getSharedClient().readSessionPresence({ source, sessionId: session.id }, signal)
    return presence === 'absent'
      ? {
          command: sequenced ? args.command : dropped.command,
          env: sequenced
            ? {
                ...env,
                [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: dropped.command,
                ...(script
                  ? {
                      [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: script.replaceAll(
                        command,
                        dropped.command
                      )
                    }
                  : {})
              }
            : env
        }
      : null
  }
  try {
    return await waitForPromiseWithSignal(decide(), signal)
  } catch {
    return null
  }
}
