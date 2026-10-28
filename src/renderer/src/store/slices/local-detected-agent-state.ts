import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
import * as contextEviction from './local-agent-context-eviction'
import { getLegacyLoadingPatch, getSupersededDetectPatch } from './local-agent-legacy-loading'
import {
  createEmptyLocalDetectedAgentState,
  localAgentInventoryFailurePatch
} from './local-detected-agent-store-state'
import * as inventory from './local-agent-inventory-outcome'
import type { LocalDetectedAgentState } from './local-detected-agent-store-state'

type LocalDetectedAgentStateCreator = StateCreator<AppState, [], [], LocalDetectedAgentState>

export const createLocalDetectedAgentState: LocalDetectedAgentStateCreator = (set, get) => {
  const detectPromises = new Map<string, Promise<TuiAgent[]>>()
  const refreshPromises = new Map<string, Promise<TuiAgent[]>>()
  const keptThroughFailure = new WeakSet<TuiAgent[]>()
  let detectedContextKey: string | null = null
  let legacyDetectContextKey: string | null = null
  let legacyRefreshContextKey: string | null = null
  let localDetectionGeneration = 0

  const actions = {
    ...createEmptyLocalDetectedAgentState(),

    readLocalAgentInventory: (id?: string | null) =>
      inventory.readLocalAgentInventoryOutcome(get(), id, keptThroughFailure),
    readLocalAgentInventoryByKey: (key: string) =>
      inventory.readLocalAgentInventoryOutcomeByKey(get(), key, keptThroughFailure),
    ensureNativeDetectedAgents: (): Promise<TuiAgent[]> =>
      actions.ensureDetectedAgents(undefined, true),
    ensureDetectedAgents: (worktreeId?: string | null, nativeHost = false): Promise<TuiAgent[]> => {
      const isFloating = nativeHost || worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const context = nativeHost
        ? undefined
        : getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
      const contextKey = localAgentInventoryContextKey(context)
      const existing = get().localDetectedAgentIdsByContext[contextKey]
      const inflightRefresh = refreshPromises.get(contextKey)
      if (inflightRefresh) {
        if (!isFloating) {
          legacyRefreshContextKey = contextKey
        }
        return inflightRefresh
      }
      if (existing != null) {
        if (!isFloating) {
          detectedContextKey = contextKey
          const state = get()
          if (state.detectedAgentIds !== existing || state.isDetectingAgents) {
            set({ detectedAgentIds: existing, isDetectingAgents: false })
          }
        }
        return Promise.resolve(existing)
      }
      const requestGeneration = localDetectionGeneration
      const exposeInflightToLegacy = (): void => {
        if (!isFloating) {
          legacyDetectContextKey = contextKey
        }
        if (isFloating) {
          return
        }
        const state = get()
        const patch = getLegacyLoadingPatch(state, detectedContextKey === contextKey, 'detect')
        if (patch) {
          set(patch)
        }
      }
      const inflight = detectPromises.get(contextKey)
      if (inflight) {
        exposeInflightToLegacy()
        return inflight
      }
      if (!isFloating) {
        legacyDetectContextKey = contextKey
      }
      set((state) => ({
        ...(isFloating
          ? {}
          : (getLegacyLoadingPatch(state, detectedContextKey === contextKey, 'detect') ?? {})),
        localDetectedAgentIdsByContext: {
          ...state.localDetectedAgentIdsByContext,
          [contextKey]: existing ?? null
        },
        isDetectingLocalAgentsByContext: {
          ...state.isDetectingLocalAgentsByContext,
          [contextKey]: true
        }
      }))
      const pending = window.api.preflight
        .detectAgents(context)
        .then((ids) => {
          const typed = ids as TuiAgent[]
          if (
            requestGeneration === localDetectionGeneration &&
            detectPromises.get(contextKey) === pending
          ) {
            const exposeToLegacy = legacyDetectContextKey === contextKey
            if (exposeToLegacy) {
              legacyDetectContextKey = null
              detectedContextKey = contextKey
            }
            set((state) => ({
              ...(exposeToLegacy ? { detectedAgentIds: typed, isDetectingAgents: false } : {}),
              localAgentInventoryFailedByContext: contextEviction.removeLocalAgentContextEntry(
                state.localAgentInventoryFailedByContext,
                contextKey
              ),
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: typed
              },
              isDetectingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntry(
                state.isDetectingLocalAgentsByContext,
                contextKey
              )
            }))
          }
          return typed
        })
        .catch(() => {
          if (
            requestGeneration === localDetectionGeneration &&
            detectPromises.get(contextKey) === pending
          ) {
            const exposeToLegacy = legacyDetectContextKey === contextKey
            if (exposeToLegacy) {
              legacyDetectContextKey = null
              detectedContextKey = contextKey
            }
            set((state) => ({
              ...(exposeToLegacy
                ? {
                    detectedAgentIds: state.localDetectedAgentIdsByContext[contextKey] ?? null,
                    isDetectingAgents: false
                  }
                : {}),
              ...localAgentInventoryFailurePatch(state, contextKey),
              isDetectingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntry(
                state.isDetectingLocalAgentsByContext,
                contextKey
              )
            }))
          }
          return [] as TuiAgent[]
        })
        .finally(() => {
          if (detectPromises.get(contextKey) === pending) {
            detectPromises.delete(contextKey)
          }
        })
      detectPromises.set(contextKey, pending)
      return pending
    },

    refreshDetectedAgents: (worktreeId?: string | null) => {
      const isFloating = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const context = getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
      const contextKey = localAgentInventoryContextKey(context)
      const requestGeneration = localDetectionGeneration
      const exposeInflightToLegacy = (): void => {
        if (!isFloating) {
          legacyRefreshContextKey = contextKey
        }
        if (isFloating) {
          return
        }
        const state = get()
        const patch = getLegacyLoadingPatch(state, detectedContextKey === contextKey, 'refresh')
        if (patch) {
          set(patch)
        }
      }
      const inflight = refreshPromises.get(contextKey)
      if (inflight) {
        exposeInflightToLegacy()
        return inflight
      }
      if (!isFloating) {
        legacyRefreshContextKey = contextKey
      }
      const supersedesDetect = detectPromises.delete(contextKey)
      const clearsLegacyDetect = legacyDetectContextKey === contextKey
      if (clearsLegacyDetect) {
        legacyDetectContextKey = null
      }
      set((state) => ({
        ...(isFloating
          ? {}
          : (getLegacyLoadingPatch(state, detectedContextKey === contextKey, 'refresh') ?? {})),
        ...getSupersededDetectPatch(state, contextKey, supersedesDetect, clearsLegacyDetect),
        isRefreshingLocalAgentsByContext: {
          ...state.isRefreshingLocalAgentsByContext,
          [contextKey]: true
        }
      }))
      const pending = window.api.preflight
        .refreshAgents(context)
        .then((result) => {
          const typed = result.agents as TuiAgent[]
          if (
            requestGeneration === localDetectionGeneration &&
            refreshPromises.get(contextKey) === pending
          ) {
            const exposeToLegacy = legacyRefreshContextKey === contextKey
            if (exposeToLegacy) {
              legacyRefreshContextKey = null
              detectedContextKey = contextKey
            }
            set((state) => ({
              ...(exposeToLegacy
                ? {
                    detectedAgentIds: typed,
                    isRefreshingAgents: false,
                    pathSource: result.pathSource,
                    pathFailureReason: result.pathFailureReason
                  }
                : {}),
              localAgentInventoryFailedByContext: contextEviction.removeLocalAgentContextEntry(
                state.localAgentInventoryFailedByContext,
                contextKey
              ),
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: typed
              },
              isRefreshingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntry(
                state.isRefreshingLocalAgentsByContext,
                contextKey
              )
            }))
          }
          return typed
        })
        .catch(() => {
          const fallback = get().localDetectedAgentIdsByContext[contextKey] ?? null
          if (
            requestGeneration === localDetectionGeneration &&
            refreshPromises.get(contextKey) === pending
          ) {
            if (fallback !== null) {
              keptThroughFailure.add(fallback)
            }
            const exposeToLegacy = legacyRefreshContextKey === contextKey
            if (exposeToLegacy) {
              legacyRefreshContextKey = null
              detectedContextKey = contextKey
            }
            set((state) => ({
              ...(exposeToLegacy ? { detectedAgentIds: fallback, isRefreshingAgents: false } : {}),
              ...localAgentInventoryFailurePatch(state, contextKey),
              isRefreshingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntry(
                state.isRefreshingLocalAgentsByContext,
                contextKey
              )
            }))
          }
          return fallback ?? []
        })
        .finally(() => {
          if (refreshPromises.get(contextKey) === pending) {
            refreshPromises.delete(contextKey)
          }
        })
      refreshPromises.set(contextKey, pending)
      return pending
    },

    clearLocalDetectedAgentContextsForProjects: (projectIds: readonly string[]) => {
      const eviction = contextEviction.getLocalAgentContextEviction({
        projectIds,
        state: get(),
        internalContextKeys: [...detectPromises.keys(), ...refreshPromises.keys()],
        detectedContextKey,
        legacyDetectContextKey,
        legacyRefreshContextKey
      })
      if (!eviction) {
        return
      }
      for (const contextKey of eviction.removedContextKeys) {
        detectPromises.delete(contextKey)
        refreshPromises.delete(contextKey)
      }
      detectedContextKey = eviction.detectedContextKey
      legacyDetectContextKey = eviction.legacyDetectContextKey
      legacyRefreshContextKey = eviction.legacyRefreshContextKey
      set(eviction.statePatch)
    },

    clearLocalDetectedAgents: () => {
      localDetectionGeneration += 1
      detectPromises.clear()
      refreshPromises.clear()
      detectedContextKey = null
      legacyDetectContextKey = null
      legacyRefreshContextKey = null
      set(createEmptyLocalDetectedAgentState())
    }
  }
  return actions
}
