import type { OrcaRuntimeWithMobileTerminalCreateOwner } from './mobile-terminal-create-owner'
import type { MobileTerminalCreateOptions } from './mobile-terminal-create-options'
import { DaemonConnectionLostError, DaemonRequestTimeoutError } from '../../../daemon/daemon-errors'
import { trackRunningAgentLaunchPane } from '../../../agent-launch/agent-launch-pane-attachment'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { AgentLaunchTabPublished } from '../../../../shared/agent-launch-tab-publication'
import type { AgentLaunchPaneVerdict } from '../../../../shared/agent-launch-pane-verdict'
import type { MobileTerminalCommand } from './mobile-terminal-startup'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { isAgentSessionOperationOutcomeUnknown } from '../../runtime-agent-launch-resolution'

export async function createPublishedSwitchTerminal(args: {
  owner: Pick<
    OrcaRuntimeWithMobileTerminalCreateOwner,
    | 'publishAgentLaunchTabInMainLayout'
    | 'publishAgentLaunchTab'
    | 'reportAgentLaunchPaneVerdict'
    | 'hasLiveTerminalForPaneKey'
    | 'withdrawAgentLaunchPaneInMainLayout'
  >
  windowAvailable: () => boolean
  worktreeId: string
  opts: MobileTerminalCreateOptions
  startupCommand: MobileTerminalCommand
  afterDesktopTabId: string | undefined
  createOwned: (identity: {
    tabId: string
    leafId: string
  }) => Promise<RuntimeMobileSessionCreateTerminalResult>
  setDestinationCurrent: (check: () => void) => void
  setTargetGroup: (group: string) => void
  wasDispatched: () => boolean
}): Promise<RuntimeMobileSessionCreateTerminalResult> {
  const {
    owner,
    windowAvailable,
    worktreeId,
    opts,
    startupCommand,
    afterDesktopTabId,
    createOwned,
    setDestinationCurrent,
    setTargetGroup,
    wasDispatched
  } = args
  opts.switchExecution!.check()
  const identity = { tabId: randomUUID(), leafId: randomUUID() }
  const pane = { worktreeId, ...identity, operationId: opts.clientMutationId }
  const paneKey = `${identity.tabId}:${identity.leafId}`
  const running = trackRunningAgentLaunchPane({ worktreeId, paneKey })
  setDestinationCurrent(() => {
    if (!running.current()) {
      throw new Error('tab_not_found')
    }
  })
  let shown: AgentLaunchTabPublished | undefined
  let publicationOwner: 'main' | 'window' = 'window'
  try {
    const request = {
      ...pane,
      launchAgent: startupCommand.launchAgent ?? 'codex',
      viewMode: 'terminal' as const,
      viewer: opts.switchExecution!.viewer,
      placement: {
        afterTabId: opts.switchExecution!.afterTabId ?? afterDesktopTabId,
        groupId: opts.targetGroupId
      },
      operationId: opts.clientMutationId
    }
    const mainPublication =
      ORCA_LAYOUT_OWNER_IS_MAIN || !windowAvailable()
        ? owner.publishAgentLaunchTabInMainLayout(request, opts.switchExecution!.check)
        : null
    publicationOwner = mainPublication ? 'main' : 'window'
    const publishing = mainPublication ?? owner.publishAgentLaunchTab(request)
    if (!publishing) {
      throw new Error('runtime_unavailable')
    }
    shown = await publishing
    setTargetGroup(shown.placement.groupId)
    await opts.switchExecution!.shown?.({
      workspaceId: worktreeId,
      ...identity,
      placement: request.placement
    })
    opts.switchExecution!.check()
    if (!running.current()) {
      throw new Error('tab_not_found')
    }
    const result = await createOwned(identity)
    running.agentBound()
    running.finish({ kind: 'proceed' })
    owner.reportAgentLaunchPaneVerdict(pane, { kind: 'proceed' })
    return result
  } catch (error) {
    const live = owner.hasLiveTerminalForPaneKey(paneKey)
    const withdraw =
      shown?.created === true &&
      running.current() &&
      !live &&
      (!wasDispatched() ||
        !(
          isAgentSessionOperationOutcomeUnknown(error) ||
          error instanceof DaemonConnectionLostError ||
          error instanceof DaemonRequestTimeoutError
        ))
    const verdict: AgentLaunchPaneVerdict = withdraw
      ? { kind: 'withdrawn' }
      : wasDispatched() && !live
        ? { kind: 'unconfirmed' }
        : { kind: 'proceed' }
    running.finish(verdict)
    if (withdraw) {
      const withdrawn = await owner.withdrawAgentLaunchPaneInMainLayout(
        pane,
        running.current,
        shown?.withdrawalRoot,
        publicationOwner
      )
      if (withdrawn && running.current()) {
        owner.reportAgentLaunchPaneVerdict(pane, verdict)
      }
    } else if (running.current() || live) {
      owner.reportAgentLaunchPaneVerdict(pane, verdict)
    }
    throw error
  }
}
