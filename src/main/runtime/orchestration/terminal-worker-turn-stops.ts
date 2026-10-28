import type { AgentPaneChange } from '../../agent-hooks/agent-transition-detector'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { hookRowAgentPhase } from '../../../shared/agent-transitions'
import type { RuntimeTerminalRead } from '../../../shared/runtime-types'
import { TerminalAgentTurnNews, type TerminalAgentTurnNewsItem } from '../terminal-agent-turn-news'
import type { OrchestrationDb } from './db'
import { redactWorkerTerminalView } from './worker-terminal-redaction'
import {
  reportWorkerTurnStop,
  type WorkerTurnStopDispatch,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'

export type TerminalWorkerTurnStopsDeps = WorkerTurnStopReportDeps & {
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  getHandle: (paneKey: string) => string | null
  getProcessIncarnation: (handle: string) => string | null
  readScreen: (handle: string) => Promise<RuntimeTerminalRead>
}

/** Report a terminal worker whose turn ended (or stopped at a prompt) while its Dispatch is open. */
export class TerminalWorkerTurnStops {
  private readonly news: TerminalAgentTurnNews<TerminalAgentTurnNewsItem>

  constructor(private readonly deps: TerminalWorkerTurnStopsDeps) {
    this.news = new TerminalAgentTurnNews({
      readHookRow: deps.readHookRow,
      prepare: (news) => news,
      deliver: (news) => void this.report(news),
      setTimer: deps.setTimer
    })
  }

  observe(change: AgentPaneChange): void {
    this.news.observe(change)
  }

  private async report({ paneKey, row }: TerminalAgentTurnNewsItem): Promise<void> {
    const stopped = this.atRest(paneKey, row) ? this.resolve(paneKey) : null
    if (!stopped) {
      return
    }
    const lastOutput = await this.deps
      .readScreen(stopped.handle)
      .then((view) => redactWorkerTerminalView(view).tail.join('\n'))
      .catch(() => undefined)
    // The read awaited: the worker may have resumed or reported since.
    const resolved = this.atRest(paneKey, row) ? this.resolve(paneKey) : null
    if (!resolved) {
      return
    }
    reportWorkerTurnStop(
      resolved.db,
      resolved.target,
      {
        from: resolved.handle,
        stopKey: `${paneKey}:${row.stateStartedAt}`,
        reason:
          hookRowAgentPhase(row) === 'needs-you'
            ? 'needs-input'
            : agentVerdictDisplayMark(row) === 'failed'
              ? 'errored'
              : 'finished',
        lastOutput
      },
      this.deps
    )
  }

  /** Still on this stop: a resumed turn, or a lead whose children still work, has not stopped. */
  private atRest(paneKey: string, row: AgentStatusIpcPayload): boolean {
    const current = this.deps.readHookRow(paneKey)
    return (
      current !== null &&
      current.state !== 'working' &&
      current.stateStartedAt === row.stateStartedAt
    )
  }

  private resolve(paneKey: string): {
    db: OrchestrationDb
    handle: string
    target: WorkerTurnStopDispatch
  } | null {
    const db = this.deps.getDb()
    const handle = db ? this.deps.getHandle(paneKey) : null
    if (!db || !handle) {
      return null
    }
    const dispatch = db.getActiveDispatchForTerminal(handle, paneKey)
    if (dispatch) {
      return { db, handle, target: { kind: 'local', dispatch } }
    }
    // A paired server holds its remote workers as attachments; their Dispatch lives at the Run home.
    const attachment = db.findActiveRemoteAttachmentForPane(paneKey)
    return attachment &&
      db.isRemoteAttachmentProcessCurrent({
        dispatchId: attachment.dispatch_id,
        paneKey,
        processIncarnation: this.deps.getProcessIncarnation(handle)
      })
      ? { db, handle, target: { kind: 'remote', attachment } }
      : null
  }
}
