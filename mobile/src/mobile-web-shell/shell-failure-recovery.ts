import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import type {
  MobileWebShellGates,
  MobileWebShellSession,
  MobileWebShellSessionState,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import { step } from './mobile-web-shell-session-step'

// The session reducer owns flow restarts; recovery only decides when deleting the host cache is warranted.
export type RefetchAfterDelete = (
  session: MobileWebShellSession,
  gates: MobileWebShellGates
) => MobileWebShellStep

// Renderer loss gets one remount without deletion; unavailable isolation is terminal; unreadable generations are refetched once.
// A failed document proves nothing about its bytes, so verify them first: a page bug must not cost a redownload on every entry.
// Ignore reports outside ready: retired-view batches must not interrupt recovery already in flight.
export function reduceShellFailed(
  session: MobileWebShellSession,
  reason: MobileWebShellFailureReason,
  refetch: RefetchAfterDelete
): MobileWebShellStep {
  const state = session.state
  if (state.kind !== 'ready') {
    return step(session, {})
  }
  switch (reason) {
    case 'isolation-unavailable':
      return step(session, { state: failedState(session, reason) })
    case 'render-process-gone':
      return remountOnce(session, reason)
    case 'generation-unreadable':
      return refetchOnce(session, reason, refetch)
    case 'document-load-failed':
      // Advance flow so the failed document's deadlines cannot land while bytes are being checked.
      return step(session, { flow: session.flow + 1 }, [
        { kind: 'verify-generation', buildId: state.buildId }
      ])
  }
}

export function reduceGenerationVerified(
  session: MobileWebShellSession,
  intact: boolean,
  refetch: RefetchAfterDelete
): MobileWebShellStep {
  if (session.state.kind !== 'ready') {
    return step(session, {})
  }
  if (session.retriedOnce) {
    return step(session, { state: failedState(session, 'document-load-failed') })
  }
  // Spend the page-failure budget, not renderer loss's: a later background renderer kill must still remount silently.
  return intact
    ? step(session, { retriedOnce: true }, [{ kind: 'remount' }])
    : refetchOnce(session, 'document-load-failed', refetch)
}

function failedState(
  session: MobileWebShellSession,
  reason: MobileWebShellFailureReason
): MobileWebShellSessionState {
  return { kind: 'failed', reason, retriedOnce: session.retriedOnce }
}

function remountOnce(
  session: MobileWebShellSession,
  reason: MobileWebShellFailureReason
): MobileWebShellStep {
  return session.remountedOnce
    ? step(session, { state: failedState(session, reason) })
    : step(session, { remountedOnce: true }, [{ kind: 'remount' }])
}

function refetchOnce(
  session: MobileWebShellSession,
  reason: MobileWebShellFailureReason,
  refetch: RefetchAfterDelete
): MobileWebShellStep {
  return session.retriedOnce || session.gates === null
    ? step(session, { state: failedState(session, reason) })
    : refetch(session, session.gates)
}
