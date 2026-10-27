import {
  resolveClaudeCommand as resolveClaudeCommandOnPath,
  resolveCodexCommand as resolveCodexCommandOnPath
} from '../../shared/node-cli-command-resolution'
import { guestNativePathEnv } from '../ipc/wsl-guest-windows-drive-path'

export {
  getVersionManagerBinPaths,
  resolveCliCommand,
  resolveCliCommands,
  resolveExecutableCommand,
  withCliRuntimeOnPath
} from '../../shared/node-cli-command-resolution'

type ResolveCommandOptions = NonNullable<Parameters<typeof resolveClaudeCommandOnPath>[0]>

/** A WSL-host orcad's PATH ends with WSL's appended Windows PATH, whose npm shims would run Windows agents; elsewhere `mounts` is empty. */
export function guestNativeCommandOptions(
  options: ResolveCommandOptions,
  mounts?: readonly string[]
): ResolveCommandOptions {
  const pathEnv = guestNativePathEnv(options.pathEnv, mounts)
  return pathEnv === options.pathEnv ? options : { ...options, pathEnv }
}

export function resolveCodexCommand(options: ResolveCommandOptions = {}): string {
  return resolveCodexCommandOnPath(guestNativeCommandOptions(options))
}

export function resolveClaudeCommand(options: ResolveCommandOptions = {}): string {
  return resolveClaudeCommandOnPath(guestNativeCommandOptions(options))
}
