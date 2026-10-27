import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'

export function snapshot(sessionId?: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'publication-test',
    snapshotVersion: Date.now(),
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: sessionId
      ? [
          {
            type: 'agent-session',
            id: `agent-session:${sessionId}`,
            sessionId,
            agent: 'claude',
            title: 'Chat',
            isActive: false
          }
        ]
      : []
  }
}
