import type { ExecutionHostId } from '../../../shared/execution-host'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import type { FolderWorkspaceLinkedTask } from '../../../shared/folder-workspace-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type {
  CreateSparseCheckoutRequest,
  SetupDecision,
  WorktreeCheckoutProgress
} from '../../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../../shared/worktree/launch-types'
import type {
  GitPushTarget,
  WorkspaceLinkedItem,
  WorkspaceStatus
} from '../../../shared/worktree/types'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { TaskSourceContext, WorkspaceRunContext } from '../../../shared/task-source-context'
import type { AgentLaunchRoute } from '@/lib/agent-launch-routing'
import { translate } from '@/i18n/i18n'
import type { MachineProviderKey } from '../../../shared/machine-inventory'
import type { MachineLifetime } from '../../../shared/machine-provider-protocol'

/** Two-phase status reported by the main process while a worktree is created.
 *  `preparing` covers renderer-side preflight before `createWorktree` starts;
 *  `fetching` covers the base-ref git fetch; `creating` covers `git worktree
 *  add`. Remote/runtime creates may skip git phases; VM recipes add a
 *  provider-provisioning phase before the runtime worktree exists. */
export type WorktreeCreationPhase =
  | 'preparing'
  | 'provisioning-vm'
  | 'starting-machine'
  | 'setting-up-project'
  | 'fetching'
  | 'creating'

export type WorktreeCreationProgressMode = 'stepped' | 'indeterminate'

/** Serializable creation intent, including any script checks deferred until
 * after the composer closes. Retained by the pending panel for Retry. */
export type WorktreeCreationRequest = {
  repoId: string
  /** Execution owner retained after script preparation, including retries. */
  executionHostId?: ExecutionHostId
  // Preserve linked-task source ownership separately from execution context so Retry never infers account from run host.
  taskSourceContext?: TaskSourceContext | null
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
  // Preserve project-first host intent for retry/diagnostics/metadata; repoId remains for older create APIs.
  workspaceRunContext?: WorkspaceRunContext | null
  // Best-effort cleanup owns this VM runtime until workspace handoff succeeds.
  ephemeralVmRuntimeId?: string
  /** Runtime environment created from the VM's pairing code. Used to refresh
   *  live status immediately after the workspace takes ownership. */
  ephemeralVmRuntimeEnvironmentId?: string
  /** Checkout ownership selected by the provisioned recipe. */
  ephemeralVmCheckoutMode?: 'orca-worktree' | 'provisioned-root'
  /** Source-host commit captured before a provisioned-root recipe starts. */
  ephemeralVmExpectedRefHead?: string
  // Retain a serializable recipe so failed creates can rerun provisioning.
  ephemeralVmRecipe?: {
    sourceRepoId: string
    recipeId: string
    projectId: string
    checkoutMode?: 'orca-worktree' | 'provisioned-root'
  }
  /** Machine to wake (when stopped), connect and set the project up on before the worktree is
   *  created. Serializable so Retry reruns the same steps. */
  machine?: {
    sourceRepoId: string
    projectId: string
    providerKey: MachineProviderKey
    /** Set once the machine exists; a create fills it in before setup starts. */
    machineId?: string
    /** Shown while the machine starts, before any host row knows it. */
    machineName: string
    /** A paired server's machine: woken through that server, then used at the selected location. */
    environmentId?: string
    create?: {
      operationId: string
      name: string
      lifetime: MachineLifetime
      ttlSeconds?: number
      image?: string
      /** Set once the create has been sent, so a Retry looks for its machine before re-sending. */
      attempted?: boolean
    }
  }
  /** Captured from the repo/run owner at submit time so Retry keeps the same
   *  local-vs-runtime progress behavior even if the focused runtime changes. */
  worktreeCreateProgressMode?: WorktreeCreationProgressMode
  name: string
  /** True only when `name` came from the creature-name generator; gates host-side retirement. */
  nameWasGenerated?: boolean
  displayName?: string
  displayNameKind?: 'generated' | 'user'
  baseBranch?: string
  compareBaseRef?: string
  setupDecision: SetupDecision
  /** Inspect and confirm scripts on the captured host after the composer closes. */
  hookPreparation?: {
    executionHostId?: ExecutionHostId
    confirmVmRecipe?: boolean
    issueCommand?: {
      provider: FolderWorkspaceLinkedTask['provider'] | null
      issueNumber: number
      artifactUrl: string | null
    }
  }
  sparseCheckout?: CreateSparseCheckoutRequest
  telemetrySource?: WorkspaceCreateTelemetrySource
  linkedIssue?: number
  linkedPR?: number
  pushTarget?: GitPushTarget
  agent: TuiAgent | null
  /** Renderer-owned route decision captured at submit time and reused on retry. */
  agentLaunchRoute?: AgentLaunchRoute
  linkedLinearIssue?: string
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  branchNameOverride?: string
  branchIntent?: 'open-existing'
  /** Parent picked in the composer's Advanced drawer. Sidebar nesting only, no git effect. */
  parentWorktreeId?: string
  workspaceStatus?: WorkspaceStatus
  linkedGitLabMR?: number
  linkedGitLabIssue?: number
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  // Backend startup payload exists only for self-contained launch; otherwise startupPlan drives it in renderer.
  startup?: WorktreeStartupLaunch
  // Trust-gated repo issue command runs in a split after the first terminal, matching the composer.
  issueCommand?: { command: string; env?: Record<string, string> }
  pendingFirstAgentMessageRename: boolean
  /** Post-create note persisted as the worktree comment. */
  note: string
  // Seed the first terminal only when backend did not launch it; null for blank shells.
  startupPlan: AgentStartupPlan | null
  quickPrompt: string
  /** Launch context delivered only as an unsent TUI-input draft (argv prefill or
   *  startup paste); completion seeds the chat-composer copy from it. */
  launchDraftPrompt?: string
  // Composer fixes launchDraftPrompt/quickPrompt delivery beside agentLaunchRoute; never rederive it later.
  promptDelivery?: 'draft' | 'auto-submit'
  quickTelemetry: AgentStartedTelemetry | null
  // Sequential-create completion must preserve focus in the next workspace name field.
  suppressTerminalFocusOnCompletion?: boolean
  /** "None" in the composer: when setup runs, open only its tab instead of an extra shell. */
  setupOnly?: boolean
}

/** Session-only creation status drives sidebar/panel and vanishes on reload; completed worktrees reconcile normally. request owns display fields and retry intent so they cannot drift. */
export type PendingWorktreeCreation = {
  creationId: string
  /** Resolved before checkout publication so passive activation can defer its initial surface. */
  worktreeId?: string
  phase: WorktreeCreationPhase
  status: 'creating' | 'error'
  startedAt: number
  // Remote/runtime targets without phase events need one indeterminate spinner, never a checklist stuck at step one.
  indeterminate: boolean
  // Background creates reveal the loader immediately; older callers opt in, keeping faux tabs stable through terminal handoff.
  loaderVisible: boolean
  error?: string
  provisioningLog?: string
  /** Machine-backed creates only: what the first stage is doing, and how long it took once done. */
  machineProgress?: {
    activity: 'creating' | 'waking' | 'connecting'
    readyAfterMs?: number
    /** Set by Cancel; the pane then offers a check for a leftover machine. */
    canceled?: boolean
    /** The leftover machine a canceled create made was deleted from its pane. */
    leftoverDeleted?: boolean
  }
  /** Git's checkout meter during a local `git worktree add`; absent when git
   *  printed none (fast or sparse checkouts, SSH and runtime creates). */
  checkoutProgress?: WorktreeCheckoutProgress
  request: WorktreeCreationRequest
}

export function findPendingWorktreeCreationId(
  pendingCreations: Readonly<Record<string, PendingWorktreeCreation>> | undefined,
  worktreeId: string | null
): string | null {
  if (!pendingCreations || !worktreeId) {
    return null
  }
  return (
    Object.values(pendingCreations).find(
      (entry) =>
        entry.status === 'creating' &&
        entry.worktreeId !== undefined &&
        worktreeIdsEqual(entry.worktreeId, worktreeId)
    )?.creationId ?? null
  )
}

export function findPendingLinkedWorkItemCreationId(
  pendingCreations: Readonly<Record<string, PendingWorktreeCreation>>,
  request: Pick<
    WorktreeCreationRequest,
    'repoId' | 'linkedIssue' | 'linkedPR' | 'workspaceRunContext'
  >
): string | null {
  if (request.linkedIssue == null && request.linkedPR == null) {
    return null
  }
  const hostId = request.workspaceRunContext?.hostId ?? null
  const match = Object.values(pendingCreations).find((entry) => {
    const pending = entry.request
    return (
      pending.repoId === request.repoId &&
      pending.linkedIssue === request.linkedIssue &&
      pending.linkedPR === request.linkedPR &&
      (pending.workspaceRunContext?.hostId ?? null) === hostId
    )
  })
  return match?.creationId ?? null
}

/** Show checkout progress only in its live phase so retries/errors cannot display stale meters. */
export function getVisibleCheckoutProgress(
  entry: Pick<PendingWorktreeCreation, 'status' | 'phase' | 'checkoutProgress'>
): WorktreeCheckoutProgress | null {
  return entry.status === 'creating' && entry.phase === 'creating'
    ? (entry.checkoutProgress ?? null)
    : null
}

/** Share in-progress copy between panel/sidebar; callers handle errors. */
export function getCreationProgressLabel(
  entry: Pick<
    PendingWorktreeCreation,
    'status' | 'phase' | 'indeterminate' | 'request' | 'checkoutProgress'
  >
): string {
  const checkout = getVisibleCheckoutProgress(entry)
  if (checkout) {
    return translate(
      'auto.lib.pendingWorktreeCreation.checkingOutFiles',
      'Checking out files… {{percent}}%',
      { percent: checkout.percent }
    )
  }
  if (entry.phase === 'provisioning-vm') {
    return translate('auto.lib.pendingWorktreeCreation.provisioningVm', 'Provisioning VM…')
  }
  if (entry.phase === 'starting-machine') {
    return translate('auto.lib.pendingWorktreeCreation.startingMachine', 'Starting machine…')
  }
  if (entry.phase === 'setting-up-project') {
    return translate('auto.lib.pendingWorktreeCreation.settingUpRepo', 'Setting up repo…')
  }
  if (entry.indeterminate) {
    return translate(
      'auto.lib.pendingWorktreeCreation.settingUpWorkspace',
      'Setting up your workspace…'
    )
  }
  if (entry.phase === 'preparing') {
    return translate('auto.lib.pendingWorktreeCreation.preparingWorkspace', 'Preparing workspace…')
  }
  return entry.phase === 'creating'
    ? translate('auto.lib.pendingWorktreeCreation.creatingWorktree', 'Creating worktree…')
    : translate('auto.lib.pendingWorktreeCreation.fetchingBaseBranch', 'Fetching base branch…')
}
