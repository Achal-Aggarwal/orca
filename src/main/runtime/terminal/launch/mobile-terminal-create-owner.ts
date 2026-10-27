import type {
  AgentLaunchTabPublishRequest,
  AgentLaunchTabPublished
} from '../../../../shared/agent-launch-tab-publication'
import type {
  AgentLaunchPaneAddress,
  AgentLaunchPaneVerdict
} from '../../../../shared/agent-launch-pane-verdict'
import type { MobileTerminalCommandOptions, MobileTerminalCommand } from './mobile-terminal-startup'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-types'
import { OrcaRuntimeWithMobileChatForkCreate } from './mobile-terminal-chat-fork-create'

export abstract class OrcaRuntimeWithMobileTerminalCreateOwner extends OrcaRuntimeWithMobileChatForkCreate {
  abstract publishAgentLaunchTab(
    request: Omit<AgentLaunchTabPublishRequest, 'requestId'>
  ): Promise<AgentLaunchTabPublished> | null

  abstract reportAgentLaunchPaneVerdict(
    pane: AgentLaunchPaneAddress,
    verdict: AgentLaunchPaneVerdict
  ): void

  protected abstract resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: MobileTerminalCommandOptions
  ): Promise<MobileTerminalCommand>

  protected abstract ensurePtyBackedMobileSurfaceForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null

  protected abstract waitForMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options?: { timeoutMs?: number; requireReady?: boolean; signal?: AbortSignal }
  ): Promise<RuntimeMobileSessionCreateTerminalResult>

  protected abstract isReadyMobileTerminalSurface(
    surface: RuntimeMobileSessionCreateTerminalResult | null
  ): boolean

  protected abstract deliverPendingStartupCommandToBareRendererPty(
    worktreeId: string,
    tabId: string
  ): void

  protected abstract findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options?: { requireReady?: boolean }
  ): RuntimeMobileSessionCreateTerminalResult | null

  protected abstract findLiveRegisteredPtyForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimePtyWorktreeRecord | null

  protected abstract hasLiveShellForRendererTab(worktreeId: string, tabId: string): boolean
}
