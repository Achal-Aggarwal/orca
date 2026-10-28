import type { OrchestrationDb } from '../db'

const mutations = [
  'createRemoteDispatchAttachment',
  'prepareRemoteAttachmentAuthority',
  'markRemoteAttachmentReady',
  'recordRemoteAttachmentStage',
  'settleRemoteAttachmentInRelayTransaction',
  'updateRemoteAttachmentSetupEvidence',
  'failRemoteAttachment',
  'beginRemoteAttachmentStop',
  'settleRemoteAttachmentStop',
  'markRemoteAttachmentStopUnknown',
  'requestRemoteAttachmentTerminalRelease',
  'routeDirectMessagePage',
  'routeUnreadDispatchMailboxToRunMailbox',
  'routeForeignDirectMessagesToOwnedMailboxes',
  'registerFederatedQuestion',
  'answerRemoteQuestion',
  'convertLifecycleMessageToRejection',
  'createWorkerTerminalResourceStatement',
  'transferWorkerTerminalResourceStatement',
  'rekeyWorkerTerminalResourcePaneKey',
  'createDispatchContext',
  'createStartingWorkerDispatch',
  'prepareStartingWorkerAuthority',
  'markWorkerDispatchReady',
  'recordWorkerStage',
  'completeDispatch',
  'completeActiveDispatchesForTask',
  'failActiveDispatchForTask',
  'failDispatch',
  'settleWorkerReport',
  'settleWorkerReportInTransaction',
  'importFederatedRelayItem',
  'reconcileFederatedWorkerStart',
  'reconcileMissingWorkerTerminal',
  'promoteReadyTasks',
  'bindRun',
  'createRun',
  'createQuestion',
  'answerQuestion',
  'closeQuestionsForDispatch',
  'createGate',
  'resolveGate',
  'timeoutGate',
  'updateTaskStatus',
  'updateFederatedDispatchResources',
  'updateFederatedDispatchRuntimeEpoch',
  'transitionLifecycle',
  'abandonWorkerDispatch',
  'failWorkerStart',
  'markWorkerStartUnknown',
  'beginWorkerStop',
  'settleWorkerStop',
  'markWorkerStopUnknown',
  'unbindOtherRunsForCoordinator',
  'recordAttemptObservation',
  'resetAll',
  'resetTasks',
  'resetMessages'
] as const satisfies readonly (keyof OrchestrationDb)[]

const trafficMutations: ReadonlySet<keyof OrchestrationDb> = new Set([
  'routeDirectMessagePage',
  'routeUnreadDispatchMailboxToRunMailbox',
  'routeForeignDirectMessagesToOwnedMailboxes',
  'registerFederatedQuestion',
  'answerRemoteQuestion',
  'convertLifecycleMessageToRejection',
  'createQuestion',
  'answerQuestion',
  'closeQuestionsForDispatch',
  'createGate',
  'resolveGate',
  'timeoutGate',
  'resetMessages'
])

/** Wake after the synchronous outer mutation; nested writes coalesce and rolled-back reads compare equal. */
export function attachCrewMutationNotifications(ctor: { prototype: object }): void {
  // SAFETY: the database installer invokes this after installing the domain methods.
  const prototype = ctor.prototype as OrchestrationDb
  const insert = prototype.insertMessage
  prototype.insertMessage = function (message) {
    const result = insert.call(this, message)
    if (result.type !== 'heartbeat') {
      this.crewChanges.notify(new Set(['traffic']))
    }
    return result
  }
  for (const name of mutations) {
    const original = prototype[name]
    if (typeof original !== 'function') {
      continue
    }
    Object.defineProperty(ctor.prototype, name, {
      configurable: true,
      writable: true,
      value(this: OrchestrationDb, ...args: unknown[]) {
        const invoke: (...values: never[]) => unknown = original
        // SAFETY: the wrapper forwards the unmodified arguments to the selected domain method.
        const result = invoke.apply(this, args as never[])
        if (
          typeof result === 'object' &&
          result !== null &&
          'types' in result &&
          Array.isArray(result.types) &&
          result.types.every((type) => type === 'heartbeat')
        ) {
          return result
        }
        this.crewChanges.notify(new Set([trafficMutations.has(name) ? 'traffic' : 'topology']))
        return result
      }
    })
  }
}
