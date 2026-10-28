import type { OrchestrationDb } from '../db'

const mutations = [
  'insertMessage',
  'insertMessages',
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

/** Wake after the synchronous outer mutation; nested writes coalesce and rolled-back reads compare equal. */
export function attachCrewMutationNotifications(ctor: { prototype: object }): void {
  for (const name of mutations) {
    const original: unknown = Reflect.get(ctor.prototype, name)
    if (typeof original !== 'function') {
      continue
    }
    Object.defineProperty(ctor.prototype, name, {
      configurable: true,
      writable: true,
      value(this: OrchestrationDb, ...args: unknown[]) {
        const result: unknown = original.apply(this, args)
        this.crewChanges.notify()
        return result
      }
    })
  }
}
