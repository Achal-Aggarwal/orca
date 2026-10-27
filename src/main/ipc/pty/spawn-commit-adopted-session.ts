import type { AgentSessionClaimedSpawnResult } from '../../../shared/agent-session-host-authority'
import type { PtySpawnResult } from '../../providers/pty-provider-contract'
import { codexReattachedHomeRouteField } from './host-env/codex-home'
import { commitAttachedPtySize } from './delivery/attached-pty-size'
import type { admitProviderReattachLaunchIdentity } from './pane/launch-authority'
import { registerPersistedPtySpawn } from './pane/spawn-registration'
import { resolvePaneSpawnReservation } from './pane/spawn-reservation'
import { savePtySpawnPaneBinding } from './spawn-commit-binding'
import type { PtySpawnCommitInput } from './spawn-commit-assembly'

export async function commitAdoptedAgentSession<Reply extends PtySpawnResult>(
  input: PtySpawnCommitInput<Reply>,
  adopted: AgentSessionClaimedSpawnResult,
  providerReattachLaunchIdentity: ReturnType<typeof admitProviderReattachLaunchIdentity>
): Promise<PtySpawnResult> {
  const { state } = input
  const { result } = state
  const runtime = state.deps.runtime
  let surface = adopted.owner.surface
  if (state.args.switchExecution) {
    const current = runtime?.resolveLiveTerminalSurface(result.id, result.incarnationId)
    if (current) {
      surface = current
    } else if (input.registration.store) {
      const binding = {
        worktreeId: surface.worktreeId,
        tabId: surface.tabId,
        leafId: surface.leafId,
        ptyId: result.id,
        incarnationId: result.incarnationId,
        mayCreate: false
      }
      await savePtySpawnPaneBinding(
        state,
        {
          store: input.registration.store,
          binding,
          refusal: 'terminal_pane_owner_changed',
          failureLog: 'Failed to reconcile attached terminal placement'
        },
        state.args.connectionId
      )
      surface = { ...surface, tabId: binding.tabId, leafId: binding.leafId }
    }
    result.switchRecoveredSurface = { tabId: surface.tabId, leafId: surface.leafId }
  }
  // Adoption proves attach even without the reply flag; size commit and joiners must agree.
  const adoptedResult = { ...result, isReattach: true }
  const rejectedRegistration = registerPersistedPtySpawn(
    runtime,
    input.registration.store,
    state.pendingRegistrationClaim,
    result.id,
    surface.worktreeId,
    null,
    {
      tabId: surface.tabId,
      leafId: surface.leafId,
      terminalHandle: surface.terminalHandle,
      ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
      ...(providerReattachLaunchIdentity ? { providerReattachLaunchIdentity } : {})
    }
  )
  if (rejectedRegistration) {
    return rejectedRegistration
  }
  runtime?.noteTerminalSpawnCommit?.(result, input.expectedSourceBinding)
  runtime?.registerPreAllocatedHandleForPty(result.id, surface.terminalHandle)
  state.deps.options?.onCodexHomePtySpawned?.({
    id: result.id,
    codexHomePath: state.selectedCodexHomePath,
    reattached: true,
    startedAt: state.codexHomeLaunchStartedAt,
    startedSequence: state.codexHomeLaunchStartedSequence,
    ...codexReattachedHomeRouteField(state.reattachedCodexHomeRoutes, result.id, true),
    ...(input.codexLaunchEnv ? { launchEnv: input.codexLaunchEnv } : {})
  })
  commitAttachedPtySize({
    result: adoptedResult,
    requested: { cols: state.args.cols, rows: state.args.rows },
    cachedBeforeAttach: state.sessionSizeBeforeAttach,
    reflowHeadlessTerminalToPtyGrid: runtime?.reflowHeadlessTerminalToPtyGrid?.bind(runtime)
  })
  resolvePaneSpawnReservation(
    state.paneSpawnReservationKey,
    state.paneSpawnReservation,
    adoptedResult
  )
  return adoptedResult
}
