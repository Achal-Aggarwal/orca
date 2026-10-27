import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { reserveRequestFor } from './structured-agent-session-attach'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'

export type StructuredAgentSessionCreateOptions = {
  check?: () => void
  firstMessage?: { clientMessageId: string; body: AgentJournalMessageItem }
  hostLaunchDirectory?: string
  catalogModels?: Parameters<typeof reserveRequestFor>[0]['models']
  /** Publish after durable creation, before agent delivery starts. */
  publishTab?: () => Promise<void>
}

/** Opening messages retain creation-time model/effort choices like later sends. */
export function openingMessageOptions(options: Readonly<Record<string, string>> | undefined): {
  options?: AgentSessionExecutionOptions
} {
  const { model, effort } = options ?? {}
  return model ? { options: { model, ...(effort ? { effort } : {}) } } : {}
}
