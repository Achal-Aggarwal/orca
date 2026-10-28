import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { prepareLegacySharedCodexSessionResume } from './codex-legacy-session-resume'

type CodexAiVaultRuntimeHome = Pick<
  CodexRuntimeHomeService,
  | 'isHostSystemDefaultRealHomeSelected'
  | 'resolveSelectedHostAccountCodexHomePathForResume'
  | 'getHostCodexHomePathsForSessionDiscovery'
>

type CodexAiVaultResumeOptions = {
  runtimeHome: CodexAiVaultRuntimeHome | null
  systemCodexHomePath: string | undefined
  /** Readies a home a pane will pin as CODEX_HOME instead of the selected account's. */
  preparePinnedLaunchHome: (home: string) => Promise<void>
}

export type NativeCodexResumePreparation = (
  args: AiVaultPrepareSessionResumeArgs,
  nativeSystemHomePath?: string
) => Promise<AiVaultPrepareSessionResumeResult>

/** Native adoption supplies its execution target; History keeps its configured storage target. */
export function codexAiVaultSessionResumePreparation(
  getOptions: () => CodexAiVaultResumeOptions
): NativeCodexResumePreparation {
  return (args, nativeSystemHomePath) => {
    const options = getOptions()
    return prepareCodexAiVaultSessionResume(args, {
      ...options,
      systemCodexHomePath: nativeSystemHomePath ?? options.systemCodexHomePath
    })
  }
}

/** Keeps window and serve AI Vault resumes behind the same refusing account-home gate. */
export async function prepareCodexAiVaultSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: CodexAiVaultResumeOptions
): Promise<AiVaultPrepareSessionResumeResult> {
  const result = await prepareLegacySharedCodexSessionResume(args, {
    isHostSystemDefaultRealHomeSelected: () =>
      options.runtimeHome?.isHostSystemDefaultRealHomeSelected() === true,
    getSelectedHostAccountCodexHomePath: () =>
      options.runtimeHome?.resolveSelectedHostAccountCodexHomePathForResume() ?? null,
    systemCodexHomePath: options.systemCodexHomePath
  })
  if (result.substituteCodexHome) {
    await options.preparePinnedLaunchHome(result.substituteCodexHome)
  }
  return result
}
