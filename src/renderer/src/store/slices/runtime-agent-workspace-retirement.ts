import { parseExecutionHostId } from '../../../../shared/execution-host'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import type { RuntimeDetectedAgentsSlice } from './runtime-detected-agents'
import { retireRuntimeAgentInventories } from './runtime-agent-inventory-cache'
import type { WorktreePurgeTarget } from './worktree-purge-target'
import {
  getRuntimeAgentInventoryKey,
  getRuntimeAgentInventoryWorktreeId
} from './runtime-agent-inventory-key'

/** Retire only the deleted workspace's host inventory; host defaults and surviving twins stay live. */
export function retireRuntimeAgentWorkspaceInventories<
  State extends RuntimeDetectedAgentsSlice & WorktreeOperationRouteState
>(state: State, targets: readonly WorktreePurgeTarget[]): Partial<RuntimeDetectedAgentsSlice> {
  const workspaceIds = new Set<string>()
  const inventoryKeys = new Set<string>()
  for (const { id, hostId } of targets) {
    if (!hostId) {
      workspaceIds.add(id)
      continue
    }
    const host = parseExecutionHostId(hostId)
    const owner =
      host?.kind === 'runtime'
        ? { kind: 'resolved' as const, environmentId: host.environmentId }
        : runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: id, hostId })
    const environmentId = owner.kind === 'resolved' ? owner.environmentId : null
    if (environmentId) {
      inventoryKeys.add(getRuntimeAgentInventoryKey(environmentId, id))
    }
  }
  if (workspaceIds.size === 0 && inventoryKeys.size === 0) {
    return {}
  }
  const patch = retireRuntimeAgentInventories(state, (key) => {
    const workspaceId = getRuntimeAgentInventoryWorktreeId(key)
    return workspaceId !== null && (workspaceIds.has(workspaceId) || inventoryKeys.has(key))
  })
  return patch === state ? {} : patch
}
