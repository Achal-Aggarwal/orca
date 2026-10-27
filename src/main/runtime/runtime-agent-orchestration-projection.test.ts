import { afterEach, describe, expect, it } from 'vitest'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import { OrchestrationDb } from './orchestration/db'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from './structured-worker-identity'

const COORDINATOR_CHAT = testOrcaSessionId('1b6f0c3a-7d2e-4a91-8c55-2e9d4b7a0f13')
const WORKER_CHAT = testOrcaSessionId('9c3e5a17-4b2d-4f60-8e91-0d7a6c2b5e48')
const TERMINAL_WORKER_HANDLE = 'term_worker'
const TERMINAL_WORKER_PANE = 'tab_w:11111111-1111-4111-8111-111111111111'

function chatRow(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}

describe('RuntimeAgentOrchestrationProjection chat lineage', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('nests chat and terminal workers under the chat that dispatched them', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'chat run',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORDINATOR_CHAT
    })
    const chatWorker = {
      handle: mintStructuredWorkerHandle(),
      sessionId: WORKER_CHAT,
      paneKey: mintStructuredWorkerPaneKey(WORKER_CHAT)
    }
    const creator = { kind: 'session', orcaSessionId: COORDINATOR_CHAT } as const
    db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'chat worker' }).id,
      assigneeHandle: chatWorker.handle,
      assigneePaneKey: chatWorker.paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_CHAT),
      creator,
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'terminal worker' }).id,
      assigneeHandle: TERMINAL_WORKER_HANDLE,
      assigneePaneKey: TERMINAL_WORKER_PANE,
      creator,
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const leaf = { ptyId: 'pty_w' } as unknown as RuntimeLeafRecord
    const projection = new RuntimeAgentOrchestrationProjection({
      getDb: () => db,
      getLeaves: () => [leaf],
      getPtys: () => [],
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      issueLeafHandle: () => TERMINAL_WORKER_HANDLE,
      issuePtyHandle: () => '',
      makePaneKey: () => TERMINAL_WORKER_PANE,
      getWorktreeId: () => null,
      getHandleForPaneKey: () => null,
      getPaneKey: () => null,
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getStructuredWorkers: () => [chatWorker],
      getSessionDisplayPaneKey: chatRow
    })

    const contexts = projection.buildByPaneKey()

    expect(contexts?.[chatRow(WORKER_CHAT)]?.parentPaneKey).toBe(chatRow(COORDINATOR_CHAT))
    expect(contexts?.[TERMINAL_WORKER_PANE]?.parentPaneKey).toBe(chatRow(COORDINATOR_CHAT))
    // The minted pane key authorizes the worker's mailbox; it must never reach a renderer.
    expect(JSON.stringify(contexts)).not.toContain(chatWorker.paneKey)
    expect(JSON.stringify(contexts)).not.toContain(chatWorker.handle)
  })
})
