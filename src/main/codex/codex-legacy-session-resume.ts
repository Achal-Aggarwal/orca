import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getSystemCodexHomePath } from './codex-home-paths'
import { resolveCodexLaunchHome } from './codex-launch-home'

/** Resume in the original store, using the selected login without publishing another rollout. */
export async function prepareLegacySharedCodexSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: {
    isHostSystemDefaultRealHomeSelected: () => boolean
    getSelectedHostAccountCodexHomePath?: () => string | null
    legacyCodexHomePath?: string
    systemCodexHomePath?: string
  }
): Promise<AiVaultPrepareSessionResumeResult> {
  if (
    args.agent !== 'codex' ||
    args.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    (args.codexHome && parseWslUncPath(args.codexHome))
  ) {
    return { useRealCodexHome: false }
  }
  const systemHome = options.systemCodexHomePath ?? getSystemCodexHomePath()
  const selectedHome = options.getSelectedHostAccountCodexHomePath?.()
  const home = resolveCodexLaunchHome({
    selectedAccount: selectedHome ? { homePath: selectedHome } : null,
    conversationHome: args.codexHome ?? systemHome,
    systemHome
  })
  return home ? { useRealCodexHome: false, substituteCodexHome: home } : { useRealCodexHome: true }
}
