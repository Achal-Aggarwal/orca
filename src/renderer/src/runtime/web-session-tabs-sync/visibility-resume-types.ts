import type { WindowVisibilitySubscriptionParking } from '../window-visibility-subscription-parking'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsRemovedResult
} from '../../../../shared/runtime-types'
import type { TrackedWebSessionTabsWorktree } from './state'

export type SessionTabsSnapshotHandler<R> = (
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  runtimeId?: string
) => R

export type VisibilityResumeEnvironment = {
  trackedWorktrees: readonly TrackedWebSessionTabsWorktree[]
  inventoryReceived: boolean
  latestInventoryReceivedFrame: number
  pendingMissingWorktrees: Set<string>
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision?: number
  expectedTrackingGeneration: number
}

export type VisibilityResumeMissing = {
  environmentId: string
  inventoryReceivedFrame: number
  trackedWorktree: TrackedWebSessionTabsWorktree
  snapshot: RuntimeMobileSessionTabsRemovedResult
  runtimeId?: string
}

export type VisibilityResumeBatch = {
  visibilityGeneration: number
  environments: Map<string, VisibilityResumeEnvironment>
  pendingInventoryCount: number
  pendingMissingByWorktree: Map<string, Map<string, VisibilityResumeMissing>>
  deferredRepairWorktrees: Set<string>
  trackedWorktreeIds: ReadonlySet<string>
  reapplyableSnapshotsByKey: Map<
    string,
    { snapshot: RuntimeMobileSessionTabsResult; receivedFrame: number; runtimeId?: string }
  >
}

export type MirroredRuntimeEnvironment = {
  environmentId: string
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision?: number
}

type Ref<T> = { current: T }

export type ActiveSubscriptionArgs = {
  activeWorktreeId: string | null
  activeWorktreeRuntimeEnvironmentId: string | null | undefined
  activeWorktreeRuntimeConnectionGeneration: number
  activeWorktreeRuntimePairingRevision: number | undefined
  workspaceSessionReady: boolean
  visibilitySnapshotReceipt: Ref<SessionTabsSnapshotHandler<void>>
  visibilitySnapshotApply: Ref<SessionTabsSnapshotHandler<boolean>>
  visibilitySnapshotAccepted: Ref<SessionTabsSnapshotHandler<void>>
}

export type ActiveSessionTabsSubscription = WindowVisibilitySubscriptionParking & {
  /** The worktree became selected again while its stream stayed warm. */
  reconsiderSelected: () => void
}
