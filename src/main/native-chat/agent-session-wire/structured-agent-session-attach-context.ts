import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import type { AgentSessionCreatePhaseRecorder } from '../../observability/agent-session-instrumentation'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import type {
  AgentSessionTurnActivity,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionConversationOpenOptions } from './structured-agent-session-conversation-open'

export type StructuredAgentSessionAttachContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  subscribers: {
    snapshot: (sessionId: string, journal: AgentSessionJournal, fence: number) => void
    publish: (
      sessionId: string,
      journal: AgentSessionJournal,
      activity?: AgentSessionTurnActivity | null
    ) => void
  }
  tasks: StructuredAgentSessionTaskQueue
  reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  publishStatus: (sessionId: string) => void
  openProviderChild?: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ) => void
  generationEnded?: StructuredAgentSessionLifetimeContext['generationEnded']
  /** Route joined Stop exits through the single child-exit handler. */
  endExitedChild: StructuredAgentSessionLifetimeContext['endExitedChild']
  wakeDelivery?: StructuredAgentSessionLifetimeContext['wakeDelivery']
  /** Reopen the conversation-owned journal when needed. */
  openConversation: (
    sessionId: string,
    options?: StructuredAgentSessionConversationOpenOptions
  ) => Promise<StructuredAgentSessionHostSession | null>
}

export type StructuredAgentSessionAttachOptions = {
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
