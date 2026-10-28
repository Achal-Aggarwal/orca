import type { LinearConnectionStatus } from '../../../../../shared/linear/workspace-types'
import type { LinearSlice, LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import { linearStatus } from '@/runtime/runtime-linear-client'
import {
  getInflightStatusRequest,
  getLinearMutationGeneration,
  invalidateLinearCaches,
  evictLinearScopeCaches,
  isCurrentLinearStatusRead,
  nextLinearStatusReadGeneration,
  setInflightStatusRequest
} from './linear-slice-request-state'
import { linearStatusScopeSignature } from './linear-cache'
import { getLinearReadScope, isCurrentLinearRuntimeContext } from './linear-slice-scope'

export function createLinearStatusActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'checkLinearConnection'> {
  return {
    checkLinearConnection: async (force = false) => {
      const scope = getLinearReadScope(get().settings)
      const contextKey = scope.runtimeContextKey
      const inflightStatusRequest = getInflightStatusRequest()
      if (inflightStatusRequest && !force && inflightStatusRequest.contextKey === contextKey) {
        return inflightStatusRequest.promise
      }
      if (get().linearStatusContextKey !== contextKey && get().linearStatusChecked) {
        set({ linearStatusChecked: false })
      }

      const mutationGeneration = getLinearMutationGeneration()
      const statusReadGeneration = nextLinearStatusReadGeneration()
      const request = linearStatus(scope.settings)
        .then((status) => {
          if (
            mutationGeneration !== getLinearMutationGeneration() ||
            !isCurrentLinearStatusRead(statusReadGeneration) ||
            !isCurrentLinearRuntimeContext(contextKey, get().settings)
          ) {
            return
          }
          const typedStatus = status as LinearConnectionStatus
          const prev = get().linearStatus
          const prevScopeSignature = linearStatusScopeSignature(prev)
          const nextScopeSignature = linearStatusScopeSignature(typedStatus)
          if (prevScopeSignature !== nextScopeSignature) {
            invalidateLinearCaches(scope)
            set({
              linearStatus: typedStatus,
              ...evictLinearScopeCaches(get(), scope),
              linearStatusChecked: true,
              linearStatusContextKey: contextKey
            })
          } else if (!get().linearStatusChecked) {
            set({ linearStatusChecked: true, linearStatusContextKey: contextKey })
          } else if (get().linearStatusContextKey !== contextKey) {
            set({ linearStatusContextKey: contextKey })
          }
        })
        .catch(() => {
          if (
            mutationGeneration !== getLinearMutationGeneration() ||
            !isCurrentLinearStatusRead(statusReadGeneration) ||
            !isCurrentLinearRuntimeContext(contextKey, get().settings)
          ) {
            return
          }
          if (get().linearStatus.connected) {
            invalidateLinearCaches(scope)
            set({
              linearStatus: { connected: false, viewer: null },
              ...evictLinearScopeCaches(get(), scope),
              linearStatusChecked: true,
              linearStatusContextKey: contextKey
            })
          } else if (!get().linearStatusChecked) {
            set({ linearStatusChecked: true, linearStatusContextKey: contextKey })
          } else if (get().linearStatusContextKey !== contextKey) {
            set({ linearStatusContextKey: contextKey })
          }
        })
        .finally(() => {
          if (
            isCurrentLinearStatusRead(statusReadGeneration) &&
            getInflightStatusRequest()?.promise === request
          ) {
            setInflightStatusRequest(null)
          }
        })
      setInflightStatusRequest({ contextKey, promise: request })

      return request
    }
  }
}
