import { createDesktopRunTerminalLifecycle } from './desktop-run-terminal-lifecycle'
import { automationRunOperationId } from './automation-run-operation'
import { observeAutomationChatRun } from './runtime-chat-run-observer'
import { readAutomationRunReceipt } from './automation-run-receipt'
import { withLiveTerminalHandle } from '../runtime/rpc/methods/agent-launch-replay'
import { tuiAgentDisplayName } from '../../shared/tui-agent-display-names'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AutomationService } from './service'
import { createHeadlessRunTerminalRetention } from './headless-run-terminal-retention'
import {
  getTuiAgentDetectCommands,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/tui-agent-config'
import {
  launchHeadlessAutomationAgent,
  publishedLaunchTarget,
  runOwnHandle
} from './headless-automation-agent-launch'
import {
  AGENT_HOOKS_REVIEW_BLOCKED_ERROR,
  createRuntimeAutomationRunTerminalObserver
} from './runtime-terminal-run-observer'
import { closeEarlierHookReviewRunTerminals } from './hook-review-blocked-run-terminals'

const MAX_REMEMBERED_LAUNCHES = 256

export function createRuntimeAutomationService(input: {
  store: Store
  runtime: OrcaRuntimeService
  claudeUsage?: ClaudeUsageStore
  codexUsage?: CodexUsageStore
  /** Execute remote_host_service schedules through the headless dispatcher. */
  headless: boolean
}): AutomationService {
  const { store, runtime, claudeUsage, codexUsage } = input
  // Launch handles remain usable before pane-key lookup resolves.
  const launchedHandles = new Map<string, string>()
  const observer = createRuntimeAutomationRunTerminalObserver(runtime, {
    getAgentStatusRowsForPane: (paneKey) => runtime.getAgentStatusRowsForPane(paneKey),
    agentCommandsForRun: (run) =>
      automationAgentCommands(
        store.listAutomations().find((entry) => entry.id === run.automationId)?.agentId
      )
  })
  let desktop: ReturnType<typeof createDesktopRunTerminalLifecycle> | undefined
  const service = new AutomationService(store, {
    claudeUsage,
    codexUsage,
    onRunFinalized: (run) => desktop?.finalize(run) ?? Promise.resolve(null),
    terminalObserver: {
      ...observer,
      resolveRunTerminal: (run) =>
        run.sessionKind === 'chat' || run.status === 'dispatching'
          ? `automation:${run.id}`
          : (runOwnHandle(runtime, run) ??
            (run.terminalPaneKey ? launchedHandles.get(run.terminalPaneKey) : undefined) ??
            observer.resolveRunTerminal(run)),
      observeCompletion: async (handle, options) => {
        let run = options.run
        let originalHandle: string | undefined
        if (run && (handle.startsWith('automation:') || run.sessionKind !== 'chat')) {
          if (!run.chatSessionId) {
            const records = await runtime.openAgentSessionRecordStore()
            const receipt = readAutomationRunReceipt(records, run)
            const agent =
              tuiAgentDisplayName(
                store.listAutomations().find((entry) => entry.id === run.automationId)?.agentId ??
                  'Agent'
              ) ?? 'Agent'
            if (!receipt) {
              return {
                status: 'dispatch_failed',
                error: `${agent} could not confirm this run after Orca restarted. Open its workspace before running again.`
              }
            }
            const originalPtyId =
              receipt.kind === 'terminal'
                ? runtime.getTerminalPtyIdForHandle(receipt.launch.outcome.handle)
                : null
            const projected =
              receipt.kind === 'terminal' ? withLiveTerminalHandle(receipt.launch, runtime) : null
            const terminal = projected?.outcome.kind === 'terminal' ? projected.outcome : null
            const observable =
              receipt.accepted &&
              (!terminal ||
                (originalPtyId !== null &&
                  (!run.terminalPtyId || run.terminalPtyId === originalPtyId) &&
                  runtime.getTerminalPtyIdForHandle(terminal.handle) === originalPtyId))
            const target = projected
              ? publishedLaunchTarget(runtime, projected)
              : {
                  workspaceId: receipt.kind === 'chat' ? receipt.workspaceId : null,
                  sessionKind: 'chat' as const,
                  chatSessionId: receipt.kind === 'chat' ? receipt.sessionId : null,
                  terminalPaneKey: null,
                  terminalSessionId: null
                }
            run = await service.markDispatchResult({
              ...target,
              runId: run.id,
              status: observable ? 'dispatched' : 'dispatch_failed',
              error: observable
                ? null
                : `${agent} could not confirm this run's prompt or original process. Open the run before trying again.`,
              terminalPtyId: originalPtyId
            })
            if (!observable) {
              return { status: 'dispatch_failed', error: run.error }
            }
            if (terminal && receipt.kind === 'terminal') {
              originalHandle = receipt.launch.outcome.handle
              handle = terminal.handle
            }
          }
          if (run.sessionKind === 'chat') {
            try {
              return await observeAutomationChatRun(runtime, run, options.signal)
            } catch (error) {
              if (options.signal.aborted) {
                throw error
              }
              console.error('[automations] chat run observation failed:', error)
              const agent =
                tuiAgentDisplayName(
                  store.listAutomations().find((entry) => entry.id === run.automationId)?.agentId ??
                    ''
                ) ?? 'The agent'
              return {
                status: 'dispatch_failed',
                error: `${agent} stopped reporting this run's result. Open the chat before running again.`
              }
            }
          }
        }
        const originalProcessMissing = (): boolean =>
          Boolean(
            run?.terminalPtyId &&
            (runtime.getTerminalPtyIdForHandle(handle) !== run.terminalPtyId ||
              (originalHandle !== undefined &&
                runtime.getTerminalPtyIdForHandle(originalHandle) !== run.terminalPtyId))
          )
        const processLost = {
          status: 'dispatch_failed' as const,
          error:
            'The agent’s original process is no longer available. Open the run before trying again.'
        }
        if (originalProcessMissing()) {
          return processLost
        }
        const observation = await observer.observeCompletion(handle, { ...options, run })
        if (originalProcessMissing()) {
          return processLost
        }
        if (options.run && observation.error === AGENT_HOOKS_REVIEW_BLOCKED_ERROR) {
          const markDispatchResult = service.markDispatchResult.bind(service)
          void closeEarlierHookReviewRunTerminals(
            { store, runtime, markDispatchResult },
            options.run
          ).catch((error: unknown) => {
            console.warn('[automations] hook-review tab cleanup failed:', error)
          })
        }
        return observation
      }
    },
    onAutomationsChanged: (payload) => {
      desktop?.reconcile()
      runtime.notifyAutomationsChanged(payload)
    },
    allowRemoteHostScheduling: input.headless,
    headlessDispatcher: async (request) => {
      const lifecycle = desktop?.begin(
        request.automation,
        request.run,
        automationRunOperationId(request.run, 'fresh-launch')
      )
      const { terminalHandle, ...launch } = await launchHeadlessAutomationAgent(
        runtime,
        {
          ...request,
          runs: store.listAutomationRuns(request.automation.id)
        },
        lifecycle
      )
      if (launch.terminalPaneKey && terminalHandle) {
        launchedHandles.set(launch.terminalPaneKey, terminalHandle)
        if (launchedHandles.size > MAX_REMEMBERED_LAUNCHES) {
          launchedHandles.delete(launchedHandles.keys().next().value ?? '')
        }
      }
      // Let the watcher retry wait timeouts until completion or its observation deadline.
      return launch
    }
  })
  runtime.setAutomationService(service)
  if (input.headless) {
    bindHeadlessRunTerminalRetention(service, store, runtime)
  } else {
    desktop = createDesktopRunTerminalLifecycle(runtime, store, (id, operation) =>
      service.runInAutomationLane(id, operation)
    )
    const stop = service.stop.bind(service)
    service.stop = () => {
      desktop?.stop()
      stop()
    }
  }
  return service
}

function bindHeadlessRunTerminalRetention(
  service: AutomationService,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  const retention = createHeadlessRunTerminalRetention({
    listRuns: () => store.listAutomationRuns(),
    terminalClientUse: (run) =>
      run.terminalPtyId ? runtime.readTerminalClientUse(run.terminalPtyId) : 'unknown',
    runTerminalAlive: (run) => runOwnHandle(runtime, run) !== null,
    shellAloneAtPrompt: (run) =>
      run.terminalPtyId
        ? runtime.confirmTerminalShellAlone(run.terminalPtyId)
        : Promise.resolve(false),
    closeRunTerminal: async (run) => {
      const handle = runOwnHandle(runtime, run)
      if (!handle) {
        return false
      }
      // Preserve user-created splits in the same tab.
      await runtime.closeTerminal(handle)
      return true
    },
    // Shared workspaces must close run panes rather than accumulate sleeping tabs.
    runOwnsWorkspace: (run) =>
      run.workspaceId !== null &&
      store.getWorktreeMeta(run.workspaceId)?.automationProvenance?.automationRunId === run.id,
    sleepRunWorkspace: async (run) => {
      const ptyId = run.terminalPtyId
      if (!run.workspaceId || !ptyId) {
        return false
      }
      try {
        // Sleep only this PTY, preserving other live terminals and the agent resume state.
        const sleep = await runtime.sleepTerminalsForWorktree(`id:${run.workspaceId}`, {
          soleLivePtyId: ptyId
        })
        // A retry may find no live PTYs if an earlier sleep stopped the process before failing.
        const slept =
          sleep.livePtyIds.length === 0 ||
          (sleep.stoppedPtyIds.includes(ptyId) && !sleep.remainingLivePtyIds?.includes(ptyId))
        if (!slept) {
          return false
        }
      } catch (error) {
        console.error('[automations] could not sleep a run workspace:', error)
        return false
      }
      // Preserve tab and pane keys for resuming the slept agent.
      await service.markDispatchResult({ runId: run.id, status: run.status, terminalPtyId: null })
      return true
    },
    inAutomationLane: (automationId, operation) =>
      service.runInAutomationLane(automationId, operation),
    forgetRunTerminal: async (run) => {
      // An idle shell proves a dispatched run exited without a completion result.
      const unfinished = run.status === 'dispatched'
      await service.markDispatchResult({
        runId: run.id,
        status: unfinished ? 'dispatch_failed' : run.status,
        error: unfinished
          ? (run.error ?? 'The agent exited without reporting completion.')
          : run.error,
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null
      })
    }
  })
  service.releaseFinishedRunTerminals = () => retention.drain()
  const start = service.start.bind(service)
  const stop = service.stop.bind(service)
  service.start = () => {
    start()
    retention.start()
  }
  service.stop = () => {
    retention.stop()
    stop()
  }
}

function automationAgentCommands(agentId: string | undefined): string[] {
  if (!isTuiAgent(agentId)) {
    return []
  }
  const config = TUI_AGENT_CONFIG[agentId]
  return [...getTuiAgentDetectCommands(config), config.launchCmd]
}
