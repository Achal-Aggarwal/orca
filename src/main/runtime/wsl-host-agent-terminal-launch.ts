import {
  isWslHostOrcadProcess,
  resolveGuestNativeProgram,
  guestNativePathEnv,
  guestNativeSpawnEnv
} from '../ipc/wsl-guest-windows-drive-path'
import { windowsOnlyCliMessage } from '../codex-cli/windows-only-agent-cli'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { TuiAgent } from '../../shared/tui-agent'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

/** On WSL host orcad, resolve agent command and reject if only Windows copy exists. */
export function resolveWslHostAgentCommand(
  bareCommand: string,
  pathEnv?: string | null
): string | null {
  if (!isWslHostOrcadProcess()) {
    return bareCommand
  }
  const cleanedPath = guestNativePathEnv(pathEnv)
  const resolved = resolveGuestNativeProgram(
    bareCommand,
    { pathEnv: cleanedPath ?? undefined },
    resolveCliCommand
  )
  if (resolved === null) {
    return null
  }
  return resolved
}

/** Check if agent is Windows-only on WSL host and throw appropriate error. */
export function checkWslHostAgentWindows(agent: TuiAgent, pathEnv?: string | null): void {
  if (!isWslHostOrcadProcess()) {
    return
  }
  const bareCommand = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], process.platform)
  const resolved = resolveWslHostAgentCommand(bareCommand, pathEnv)
  if (resolved === null) {
    throw new Error(
      windowsOnlyCliMessage(`/proc/orca-agent-cli-installed-only-on-windows/${agent}`, agent) ||
        `${agent} is installed only on Windows, not in this WSL distro.`
    )
  }
}

/** Apply cleaned PATH to spawn environment on WSL host. */
export function applyWslHostSpawnEnv(env: Record<string, string>): Record<string, string> {
  if (!isWslHostOrcadProcess()) {
    return env
  }
  const wslEnv = guestNativeSpawnEnv(env)
  const filteredEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(wslEnv)) {
    if (value !== undefined) {
      filteredEnv[key] = value
    }
  }
  return filteredEnv
}

/** Get the command override for WSL host if agent resolves to absolute path. */
export function getWslHostAgentCommandOverride(
  agent: TuiAgent,
  platform: NodeJS.Platform,
  pathEnv?: string | null
): string | null {
  if (!isWslHostOrcadProcess()) {
    return null
  }
  const bareCommand = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], platform)
  const resolved = resolveWslHostAgentCommand(bareCommand, pathEnv)
  if (resolved && resolved !== bareCommand) {
    return resolved
  }
  return null
}
