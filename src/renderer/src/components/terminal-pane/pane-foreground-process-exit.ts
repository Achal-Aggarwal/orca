import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'

import type { PaneForegroundAgentTrackerDeps } from './pane-foreground-agent-tracker-contract'

export function confirmPaneForegroundProcessExit(args: {
  deps: PaneForegroundAgentTrackerDeps
  process: RecognizedAgentProcess
  disposed: boolean
  commandReadInFlight: boolean
  pendingRead: boolean
  cancelPendingRead: () => void
  clearAgentEvidence: () => void
  resetStartupSample: () => void
}): void {
  const {
    deps,
    process,
    disposed,
    commandReadInFlight,
    pendingRead,
    cancelPendingRead,
    clearAgentEvidence,
    resetStartupSample
  } = args
  // Why: an in-flight command read owns the pane's next identity, and only a live read is ours.
  const published = deps.getPublishedEntry?.()
  if (
    disposed ||
    commandReadInFlight ||
    published?.agentEvidence !== 'process-read' ||
    resolveCompatibleAgentTypeForOwner(process.agent, published.agent) !== published.agent
  ) {
    return
  }
  const hadVisibleRead = pendingRead
  cancelPendingRead()
  clearAgentEvidence()
  resetStartupSample()
  // Without command marks, shellForeground would never lift and would block Enter from identifying the next agent.
  deps.publish({ agent: null, shellForeground: false })
  if (hadVisibleRead) {
    deps.onVisibleForegroundSettled?.('shell')
  }
  deps.onConfirmedShellForeground?.('process-exit')
}
