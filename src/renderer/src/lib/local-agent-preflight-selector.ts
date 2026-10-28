import { createLocalProjectRuntimeWorkspaceSelector } from './local-project-runtime-workspace'
import {
  selectLocalAgentPreflightInput,
  resolveLocalAgentPreflightInput,
  type LocalPreflightContext
} from './local-preflight-context'
import {
  normalizeGlobalWindowsRuntimeDefault,
  normalizeProjectRuntimePreference
} from '../../../shared/project-execution-runtime'
import { hasCachedWindowsTerminalCapabilities } from './windows-terminal-capabilities'

/** One current selection per mounted target; inventory and action authority stay live. */
export function createLocalAgentPreflightSelector(worktreeId?: string | null) {
  const readWorkspace = createLocalProjectRuntimeWorkspaceSelector()
  let previous: readonly unknown[] | undefined
  let context: LocalPreflightContext
  return (state: Parameters<typeof selectLocalAgentPreflightInput>[0]): LocalPreflightContext => {
    const input = selectLocalAgentPreflightInput(
      state,
      undefined,
      undefined,
      worktreeId,
      readWorkspace
    )
    const preference =
      typeof input === 'object'
        ? normalizeProjectRuntimePreference(input.projectRuntimePreference)
        : undefined
    const fallback =
      typeof input === 'object'
        ? normalizeGlobalWindowsRuntimeDefault(input.globalWindowsRuntimeDefault)
        : undefined
    const inherited = preference?.kind === 'inherit-global'
    const distro =
      preference?.kind === 'wsl'
        ? preference.distro
        : inherited && fallback?.kind === 'wsl'
          ? fallback.distro
          : null
    const facts =
      typeof input === 'object'
        ? [
            input.appPlatform,
            input.projectId,
            preference?.kind,
            preference?.kind === 'wsl' ? preference.distro : undefined,
            inherited ? fallback?.kind : undefined,
            inherited && fallback?.kind === 'wsl' ? fallback.distro : undefined,
            distro ? input.wslAvailable : undefined,
            distro ? hasCachedWindowsTerminalCapabilities() : undefined,
            distro ? input.availableWslDistros?.includes(distro) : undefined
          ]
        : [input]
    if (
      !previous ||
      facts.length !== previous.length ||
      facts.some((value, i) => value !== previous?.[i])
    ) {
      previous = facts
      context = resolveLocalAgentPreflightInput(input)
    }
    return context
  }
}
