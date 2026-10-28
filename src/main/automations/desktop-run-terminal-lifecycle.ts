import { reconcileDesktopRunTerminals } from './desktop-run-terminal-reconciliation'
import {
  stopDesktopRunTerminal,
  watchDesktopTerminalStop,
  stopRevokers
} from './desktop-run-terminal-stop'
import { randomUUID } from 'node:crypto'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationRun
} from '../../shared/automations-types'
import type {
  AutomationTerminalCorrelation,
  AutomationTerminalLifecycleRequest,
  AutomationTerminalLifecycleResponse,
  AutomationTerminalTarget
} from '../../shared/automation-terminal-lifecycle'
import { makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import { requestAutomationTerminalLifecycle } from '../window/terminal-tab-close-request-relay'
import { terminalPresentationRequest } from '../window/runtime-window-lifecycle'
import type { AgentLaunchHostPolicy } from '../runtime/rpc/methods/agent-launch-surfaces'

export function createDesktopRunTerminalLifecycle(
  runtime: OrcaRuntimeService,
  store: Store,
  inLane: <T>(automationId: string, operation: () => Promise<T>) => Promise<T>
) {
  const generation = randomUUID()
  const registrations = new Map<string, ReturnType<typeof register>>()
  function register(
    automation: Automation,
    run: Pick<AutomationRun, 'id' | 'createdAt'>,
    operationId: string
  ) {
    const window = runtime.getAuthoritativeWindow()
    const web = window.webContents
    const frame = web.mainFrame
    const abort = new AbortController()
    const registrationId = randomUUID()
    const paneKey = makePaneKey(randomUUID(), randomUUID())
    const pane = parsePaneKey(paneKey)!
    let epoch: string | null = null
    let target: AutomationTerminalTarget | null = null
    let ptyId: string | null = null
    let incarnationId: string | null | undefined
    let finalizing = false
    let enrollment = Promise.resolve()
    const listeners: (() => void)[] = []
    const valid = (): boolean => {
      try {
        return (
          !abort.signal.aborted &&
          !window.isDestroyed() &&
          !web.isDestroyed() &&
          web.mainFrame === frame &&
          runtime.getAuthoritativeWindow() === window
        )
      } catch {
        return false
      }
    }
    type Operation<R = AutomationTerminalLifecycleRequest> = R extends AutomationTerminalCorrelation
      ? Omit<R, keyof AutomationTerminalCorrelation>
      : never
    const correlation = {
      registrationId,
      runId: run.id,
      operationId,
      serviceGeneration: generation
    }
    const envelope = (operation: Operation): AutomationTerminalLifecycleRequest => ({
      ...correlation,
      requestId: randomUUID(),
      documentEpoch: epoch,
      ...operation
    })
    const request = (operation: Operation): Promise<AutomationTerminalLifecycleResponse> =>
      requestAutomationTerminalLifecycle(window, envelope(operation), abort.signal, valid).then(
        (reply) => {
          if (
            !valid() ||
            reply.registrationId !== correlation.registrationId ||
            reply.runId !== correlation.runId ||
            reply.operationId !== correlation.operationId ||
            reply.serviceGeneration !== correlation.serviceGeneration ||
            (epoch !== null && reply.documentEpoch !== epoch)
          ) {
            throw new Error('terminal_lifecycle_owner_lost')
          }
          return reply
        }
      )
    const release = (): void => {
      if (abort.signal.aborted) {
        return
      }
      // Enqueue release to this document only; cancellation cannot retarget a new window.
      try {
        if (valid()) {
          web.send('automations:terminalLifecycleRequest', envelope({ operation: 'release' }))
        }
      } catch {
        /* The document is already unreachable. */
      }
      abort.abort()
      for (const dispose of listeners) {
        dispose()
      }
      stopRevokers.delete(registrationId)
      registrations.delete(run.id)
    }
    listeners.push(...watchDesktopTerminalStop(window, web, release))
    const revoker: { ptyId: string | null; release: () => void } = { ptyId, release }
    stopRevokers.set(registrationId, revoker)
    const reserve = (worktreeId: string): void => {
      if (target || !valid()) {
        return
      }
      target = { worktreeId, tabId: pane.tabId, leafId: pane.leafId, paneKey }
      try {
        enrollment = request({ operation: 'arm', target }).then((reply) => {
          if (reply.disposition !== 'armed' || !reply.documentEpoch) {
            throw new Error('terminal_lifecycle_not_armed')
          }
          epoch = reply.documentEpoch
        })
        void enrollment.catch(release)
      } catch {
        release()
      }
    }
    const policy: AgentLaunchHostPolicy = {
      onWorkspaceCreated: reserve,
      onSurfacePublished: (surface) => {
        if (
          surface.outcome.kind !== 'terminal' ||
          !target ||
          surface.worktreeId !== target.worktreeId ||
          surface.outcome.paneKey !== paneKey ||
          ptyId
        ) {
          release()
          return
        }
        ptyId = runtime.getTerminalPtyIdForHandle(surface.outcome.handle)
        if (!ptyId) {
          release()
          return
        }
        const metadata = runtime.getPtyExecutionHostMetadata(ptyId)
        incarnationId = metadata.incarnationId
        if (!incarnationId || metadata.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
          release()
          return
        }
        revoker.ptyId = ptyId
        web.send(
          'ui:createTerminal',
          terminalPresentationRequest(target.worktreeId, {
            ptyId,
            tabId: pane.tabId,
            leafId: pane.leafId,
            presentation: 'background',
            surfaceOwner: false,
            activate: false,
            expectedProcessIdentity: { terminalHandle: surface.outcome.handle, incarnationId }
          })
        )
        enrollment = enrollment.then(async () => {
          const reply = await request({
            operation: 'bind',
            ptyId: ptyId!,
            incarnationId: incarnationId!,
            hostId: LOCAL_EXECUTION_HOST_ID
          })
          if (reply.disposition !== 'bound') {
            release()
          }
        })
        void enrollment.catch(release)
      }
    }
    return {
      paneKey,
      policy,
      reserve,
      release,
      finalize: async (completed: AutomationRun): Promise<AutomationDispatchResult | null> => {
        if (finalizing) {
          return null
        }
        finalizing = true
        try {
          await enrollment
          if (
            !valid() ||
            completed.status !== 'completed' ||
            completed.terminalPtyId !== ptyId ||
            !target ||
            !ptyId ||
            !incarnationId
          ) {
            return null
          }
          const { worktreeId } = target
          const expectedPtyId = ptyId
          const expectedIncarnationId = incarnationId
          return await inLane(automation.id, async () => {
            const eligible = (): boolean =>
              valid() &&
              runtime.getTerminalPtyIdForHandle(
                runtime.getTerminalHandleForPaneKey(paneKey) ?? ''
              ) === expectedPtyId &&
              runtime.getPtyExecutionHostMetadata(expectedPtyId).incarnationId ===
                expectedIncarnationId &&
              runtime.terminalRunFacts.readLastDrivingInputAt(expectedPtyId) === null
            if (!eligible()) {
              return null
            }
            const prepared = await request({
              operation: 'finalize',
              phase: 'prepare',
              preservePane:
                store.getWorktreeMeta(worktreeId)?.automationProvenance?.automationRunId === run.id
            })
            if (prepared.disposition !== 'prepared') {
              return null
            }
            const proof = await stopDesktopRunTerminal(
              runtime,
              worktreeId,
              expectedPtyId,
              expectedIncarnationId,
              async () => {
                if (!eligible()) {
                  return false
                }
                const answer = await request({ operation: 'finalize', phase: 'authorize' })
                return answer.disposition === 'authorized' && eligible()
              }
            )
            let disposition: AutomationTerminalLifecycleResponse['disposition'] = 'unproven'
            try {
              disposition = (await request({ operation: 'finalize', phase: 'stop-settled', proof }))
                .disposition
            } catch {
              /* Keep recovery identity when acknowledgement is lost. */
            }
            return proof === 'stopped'
              ? {
                  runId: run.id,
                  status: completed.status,
                  terminalPtyId: null,
                  ...(disposition === 'closed'
                    ? { terminalPaneKey: null, terminalSessionId: null }
                    : {})
                }
              : null
          })
        } catch {
          return null
        } finally {
          release()
        }
      }
    }
  }
  return {
    begin: (
      automation: Automation,
      run: Pick<AutomationRun, 'id' | 'createdAt'>,
      operationId: string
    ) => {
      if (automation.reuseSession) {
        return null
      }
      try {
        const registration = register(automation, run, operationId)
        registrations.set(run.id, registration)
        return registration
      } catch {
        return null
      }
    },
    finalize: (run: AutomationRun) =>
      registrations.get(run.id)?.finalize(run) ?? Promise.resolve(null),
    reconcile: () => reconcileDesktopRunTerminals(registrations, () => store.listAutomationRuns()),
    stop: () => {
      for (const owner of registrations.values()) {
        owner.release()
      }
    }
  }
}
