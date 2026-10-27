import type { AttachFlowInput } from './structured-agent-session-attach-flow'

import type { AgentSessionCreatePhaseRecorder } from '../../observability/agent-session-instrumentation'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'

export type StructuredAgentSessionAttachOptions = {
  checkBeforeAcquire?: () => void
  hostLaunchDirectory?: string
  catalogModels?: AttachFlowInput['models']
  recordPhase?: AgentSessionCreatePhaseRecorder
  onAcquisitionFailed?: AttachFlowInput['onAcquisitionFailed']
  startedFor?: string
  startupOptions?: Readonly<Record<string, string>>
  /** Preserve cancellation reason when host Stop/close/quit aborts attach. */
  onAborted?: () => void
  /** Startup expiry is failure, not user cancellation. */
  onStartupExpired?: () => void
  /** Background starts wait outside serialization and commit under it. */
  lock?: StructuredAgentSessionAttachLock
  startupAttemptId?: string
  onPublished?: () => void
}
