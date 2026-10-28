import type { LinearViewer } from '../../../../../shared/linear/workspace-types'
import type { LinearSlice, LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import {
  linearConnect,
  linearDisconnect,
  linearDisconnectWorkspace,
  linearSelectWorkspace,
  linearStatus,
  linearTestConnection
} from '@/runtime/runtime-linear-client'
import { translate } from '@/i18n/i18n'
import {
  beginLinearMutation,
  invalidateLinearCaches,
  evictLinearScopeCaches,
  isCurrentLinearMutation
} from './linear-slice-request-state'
import { detachLinearIssuePublication } from './linear-issue-publication'
import { getLinearReadScope, isCurrentLinearRuntimeContext } from './linear-slice-scope'
import { linearStatusScopeSignature } from './linear-cache'

export function createLinearConnectionActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<
  LinearSlice,
  | 'testLinearConnection'
  | 'connectLinear'
  | 'selectLinearWorkspace'
  | 'disconnectLinear'
  | 'disconnectLinearWorkspace'
> {
  return {
    testLinearConnection: async (workspaceId) => {
      const scope = getLinearReadScope(get().settings)
      const requestGeneration = beginLinearMutation()
      const contextKey = scope.runtimeContextKey
      try {
        const result = await linearTestConnection(scope.settings, workspaceId)
        if (
          !isCurrentLinearMutation(requestGeneration) ||
          !isCurrentLinearRuntimeContext(contextKey, get().settings)
        ) {
          return result
        }
        const status = await linearStatus(scope.settings)
        if (
          isCurrentLinearMutation(requestGeneration) &&
          isCurrentLinearRuntimeContext(contextKey, get().settings)
        ) {
          const prev = get().linearStatus
          if (linearStatusScopeSignature(prev) !== linearStatusScopeSignature(status)) {
            invalidateLinearCaches(scope)
            set({
              linearStatus: status,
              ...evictLinearScopeCaches(get(), scope),
              linearStatusChecked: true,
              linearStatusContextKey: contextKey
            })
          } else if (!get().linearStatusChecked || get().linearStatusContextKey !== contextKey) {
            // Preserve the status reference when the probe did not change scope.
            set({ linearStatusChecked: true, linearStatusContextKey: contextKey })
          }
        }
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Test failed'
        return { ok: false as const, error: message }
      }
    },

    connectLinear: async (apiKey: string) => {
      const scope = getLinearReadScope(get().settings)
      const requestGeneration = beginLinearMutation()
      const contextKey = scope.runtimeContextKey
      try {
        const result = await linearConnect(scope.settings, apiKey)
        if (
          result.ok &&
          isCurrentLinearMutation(requestGeneration) &&
          isCurrentLinearRuntimeContext(contextKey, get().settings)
        ) {
          invalidateLinearCaches(scope)
          set({
            ...evictLinearScopeCaches(get(), scope)
          })
          const status = await linearStatus(scope.settings)
          if (
            !isCurrentLinearMutation(requestGeneration) ||
            !isCurrentLinearRuntimeContext(contextKey, get().settings)
          ) {
            return {
              ok: false as const,
              error: translate(
                'auto.store.slices.linear.37d36984d0',
                'Linear connection was superseded by a newer request.'
              )
            }
          }
          set({
            linearStatus: status,
            linearStatusChecked: true,
            linearStatusContextKey: contextKey
          })
        } else if (result.ok) {
          return {
            ok: false as const,
            error: translate(
              'auto.store.slices.linear.37d36984d0',
              'Linear connection was superseded by a newer request.'
            )
          }
        }
        return result as { ok: true; viewer: LinearViewer } | { ok: false; error: string }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection failed'
        return { ok: false as const, error: message }
      }
    },

    selectLinearWorkspace: async (workspaceId) => {
      const scope = getLinearReadScope(get().settings)
      const requestGeneration = beginLinearMutation()
      const contextKey = scope.runtimeContextKey
      const status = await linearSelectWorkspace(scope.settings, workspaceId)
      if (
        !isCurrentLinearMutation(requestGeneration) ||
        !isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      invalidateLinearCaches(scope)
      set({
        linearStatus: status,
        ...evictLinearScopeCaches(get(), scope),
        linearStatusChecked: true,
        linearStatusContextKey: contextKey
      })
    },

    disconnectLinear: async () => {
      const scope = getLinearReadScope(get().settings)
      const requestGeneration = beginLinearMutation()
      const contextKey = scope.runtimeContextKey
      detachLinearIssuePublication(scope, true)
      await linearDisconnect(scope.settings)
      if (
        !isCurrentLinearMutation(requestGeneration) ||
        !isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      invalidateLinearCaches(scope)
      set({
        linearStatus: { connected: false, viewer: null },
        ...evictLinearScopeCaches(get(), scope),
        linearStatusChecked: true,
        linearStatusContextKey: contextKey
      })
    },

    disconnectLinearWorkspace: async (workspaceId) => {
      const scope = getLinearReadScope(get().settings)
      const requestGeneration = beginLinearMutation()
      const contextKey = scope.runtimeContextKey
      await linearDisconnectWorkspace(scope.settings, workspaceId)
      if (
        !isCurrentLinearMutation(requestGeneration) ||
        !isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      const status = await linearStatus(scope.settings)
      if (
        !isCurrentLinearMutation(requestGeneration) ||
        !isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      invalidateLinearCaches(scope)
      set({
        linearStatus: status,
        ...evictLinearScopeCaches(get(), scope),
        linearStatusChecked: true,
        linearStatusContextKey: contextKey
      })
    }
  }
}
