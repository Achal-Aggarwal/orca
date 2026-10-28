import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useWorktreeAgentRows } from '@/components/sidebar/useWorktreeAgentRows'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { findAgentMessageSenderChatTab } from './native-chat-agent-message-sender-label'

const handleIndexes = new WeakMap<object, Map<string, AgentStatusEntry[]>>()
function byHandle(source: AppState['agentStatusByPaneKey'] | AppState['retainedAgentsByPaneKey']) {
  let index = handleIndexes.get(source)
  if (!index) {
    index = new Map()
    for (const value of Object.values(source)) {
      const entry = 'entry' in value ? value.entry : value
      if (entry.terminalHandle) {
        const entries = index.get(entry.terminalHandle) ?? []
        entries.push(entry)
        index.set(entry.terminalHandle, entries)
      }
    }
    handleIndexes.set(source, index)
  }
  return index
}

export function useAgentMessageSenderView(
  sender: AgentMessageSender | undefined,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget
) {
  const owner = useAppStore((state) =>
    target
      ? executionHostIdForStructuredTarget(target)
      : chatWorktreeId
        ? getKnownExecutionHostIdForWorktree(state, chatWorktreeId)
        : null
  )
  const chatTab = useAppStore((state) =>
    sender?.party.orcaSessionId && !sender.party.address.startsWith('dispatch:')
      ? findAgentMessageSenderChatTab(state, sender.party.orcaSessionId, owner)
      : undefined
  )
  const paneKey = useAppStore((state) => {
    if (!sender || sender.party.address.startsWith('dispatch:')) return undefined
    if (chatTab) return structuredAgentSessionPaneKey(chatTab.id, chatTab.entityId)
    const handle = sender.party.terminalHandle
    if (!handle) return undefined
    for (const source of [state.agentStatusByPaneKey, state.retainedAgentsByPaneKey]) {
      const matches = (byHandle(source).get(handle) ?? []).filter(
        (entry) =>
          entry.worktreeId && getKnownExecutionHostIdForWorktree(state, entry.worktreeId) === owner
      )
      if (matches.length) return matches.length === 1 ? matches[0].paneKey : undefined
    }
    return undefined
  })
  const worktreeId = useAppStore(
    (state) =>
      chatTab?.worktreeId ??
      (paneKey
        ? (state.agentStatusByPaneKey[paneKey]?.worktreeId ??
          state.retainedAgentsByPaneKey[paneKey]?.worktreeId)
        : undefined)
  )
  const rows = useWorktreeAgentRows(worktreeId ?? '', Boolean(worktreeId && paneKey))
  const row = rows.find((candidate) => candidate.paneKey === paneKey)
  return {
    agentType: row?.agentType ?? chatTab?.agentSessionAgent,
    dot: row ? agentRowDisplayDotState(row) : undefined
  }
}
