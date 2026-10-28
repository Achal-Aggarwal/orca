import type { GitRuntimeOptions } from '../git-runtime-options'
import { wslDistroForCommand } from '../command-runner/git-command-resolution'
import { usesHostGitForWslLinkedWorktree } from '../wsl-linked-worktree-git-routing'

export function workingSymlinkTargetForGit(
  target: string,
  worktreePath: string,
  options: GitRuntimeOptions
): string {
  if (
    process.platform !== 'win32' ||
    (wslDistroForCommand(worktreePath, options.wslDistro) &&
      !usesHostGitForWslLinkedWorktree(worktreePath, options.wslDistro))
  ) {
    return target
  }
  // Windows Git stores forward slashes without Win32/NT namespace prefixes.
  let unprefixed = target
  if (target.startsWith('\\')) {
    if (target.startsWith('\\\\?\\') || target.startsWith('\\??\\')) {
      unprefixed = target.slice(4)
    } else if (target.slice(0, 12).toLowerCase() === '\\dosdevices\\') {
      unprefixed = target.slice(12)
    }
    if (unprefixed.slice(0, 4).toUpperCase() === 'UNC\\') {
      unprefixed = `\\\\${unprefixed.slice(4)}`
    }
  }
  return unprefixed.replace(/\\/g, '/')
}
