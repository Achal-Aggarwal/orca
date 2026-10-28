import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'

export function restingJournal(items: AgentJournalItemBody[] = [], wroteBeforeOpen = false) {
  return {
    threadGoal: () => null,
    visitItems: (visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void) =>
      items.forEach((body, index) => visit(`item-${index}`, index + 1, body)),
    wroteBeforeOpen: () => wroteBeforeOpen,
    submissions: () => [],
    contextUsage: () => null,
    context: { floor: () => null }
  }
}

export function restingRecord(): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId: 'session-1',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/homes/a' },
    providerHandleChain: [],
    location: { executionHostId: 'local', wslDistro: null },
    options: {}
  })
}
