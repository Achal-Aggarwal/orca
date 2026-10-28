import { randomUUID } from 'node:crypto'
import { defineMethod, defineStreamingMethod } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  WorktreeReviewSubscribe,
  WorktreeReviewSubscription
} from '../../../../shared/rpc-contract/worktree-review-params'
import { WorkspaceReviewSubscription } from '../../workspace-review-subscription'

const subscriptions = new WeakMap<OrcaRuntimeService, Map<string, WorkspaceReviewSubscription>>()

export const WORKTREE_REVIEW_METHODS = [
  defineStreamingMethod({
    name: 'worktree.review.subscribe',
    permission: 'workspace',
    params: WorktreeReviewSubscribe,
    handler: async (params, { runtime, connectionId, requestId, signal }, emit) => {
      let registry = subscriptions.get(runtime)
      if (!registry) {
        registry = new Map()
        subscriptions.set(runtime, registry)
      }
      if (connectionId) {
        for (const previous of registry.values()) {
          if (previous.connectionId === connectionId) {
            previous.close()
          }
        }
      }
      if (registry.size >= 128) {
        throw new Error('review_subscription_capacity')
      }
      const id = `worktree-review:${randomUUID()}`
      const subscription = new WorkspaceReviewSubscription(runtime, {
        subscriptionId: id,
        selector: params.worktree,
        connectionId,
        requestId,
        emit,
        onClose: () => registry.delete(id),
        signal
      })
      if (signal?.aborted) {
        return
      }
      registry.set(id, subscription)
      try {
        emit({ type: 'ready', subscriptionId: id })
      } catch {
        subscription.close()
        return
      }
      await subscription.renew()
    }
  }),
  defineMethod({
    name: 'worktree.review.renew',
    permission: 'workspace',
    params: WorktreeReviewSubscription,
    handler: async (params, { runtime, connectionId }) => {
      const subscription = subscriptions.get(runtime)?.get(params.subscriptionId)
      return {
        renewed:
          !!subscription &&
          subscription.connectionId === connectionId &&
          (await subscription.renew())
      }
    }
  }),
  defineMethod({
    name: 'worktree.review.unsubscribe',
    permission: 'workspace',
    params: WorktreeReviewSubscription,
    handler: async (params, { runtime, connectionId }) => {
      const subscription = subscriptions.get(runtime)?.get(params.subscriptionId)
      const unsubscribed = !!subscription && subscription.connectionId === connectionId
      if (unsubscribed) {
        subscription.close()
      }
      return { unsubscribed }
    }
  })
]
