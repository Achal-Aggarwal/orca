import { basename, dirname, join } from 'node:path'
import { resolveCodexLaunchHome } from '../codex/codex-launch-home'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import {
  listGuestCodexAccountHomes,
  resolveGuestCodexAccountHome
} from '../codex-accounts/guest-codex-account-homes'
import { reconcileCodexAccountHomeHook } from '../codex/codex-account-home-hook'
import { stopCodexStateDbBackfillRecoveries } from '../codex/codex-state-db-backfill-recovery'
import type { GetSelectedCodexHomePath } from '../ipc/pty/host-env/types'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

/** Keep host status hooks and session discovery in client-selected managed CODEX_HOME paths. */
export function orcadCodexAccountHomes(
  getSettings: () => GlobalSettings,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
) {
  registerCleanup(() => stopCodexStateDbBackfillRecoveries())
  const launchHome = (
    env?: NodeJS.ProcessEnv,
    readOnly = true,
    conversationHome?: string
  ): string | null => {
    const home = resolveGuestCodexAccountHome(env?.CODEX_HOME)
    if (!home) {
      return null
    }
    const isOverlay = basename(dirname(home)) === 'overlays'
    const loginHome = isOverlay ? join(dirname(dirname(home)), 'home') : home
    return (
      resolveCodexLaunchHome({
        selectedAccount: { homePath: loginHome },
        conversationHome: conversationHome ?? (isOverlay ? home : undefined),
        storeHome: resolveHostCodexSessionSourceHome(getSettings()),
        readOnly
      }) ?? null
    )
  }
  const selectLaunchHome: GetSelectedCodexHomePath = async (_target, launchEnv, context) => {
    // Wire-supplied CODEX_HOME must be managed; user-owned homes are not ours to edit.
    const home = launchHome(launchEnv, false, context?.conversationHome)
    if (!home) {
      return null
    }
    await reconcileCodexAccountHomeHook(
      home,
      () => isAgentStatusHooksEnabledForAgent(getSettings(), 'codex'),
      context?.launchesCodex === true
    )
    return home
  }
  return {
    selectLaunchHome,
    /** Read selected homes without hook reconciliation for record-less catalogs. */
    readLaunchHome: (launchEnv?: NodeJS.ProcessEnv, conversationHome?: string): string | null =>
      launchHome(launchEnv, true, conversationHome),
    listSessionHomes: (): readonly string[] => listGuestCodexAccountHomes()
  }
}
