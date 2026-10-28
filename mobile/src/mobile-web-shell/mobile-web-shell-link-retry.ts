import { awaitsGates, gateKey, gateVerdict } from './mobile-web-shell-gates'
import type {
  MobileWebShellGates,
  MobileWebShellSession,
  MobileWebShellSessionEvent,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import { step } from './mobile-web-shell-session-step'
import {
  readFailureSide,
  type MobileWebShellUpdateFailureCause
} from './mobile-web-shell-update-failure'

type RestartFlow = (
  session: MobileWebShellSession,
  gates: MobileWebShellGates
) => MobileWebShellStep

export function reduceGateEvent(
  session: MobileWebShellSession,
  event: Extract<MobileWebShellSessionEvent, { type: 'gates-changed' | 'app-foregrounded' }>,
  restart: RestartFlow
): MobileWebShellStep {
  return event.type === 'gates-changed'
    ? reduceGatesChanged(session, event.gates, restart)
    : reduceAppForegrounded(session, restart)
}

// A download with nothing cached to fall back on; only link loss retries, as a host refusal would refuse the retry too.
export function reduceUncachedDownloadFailed(
  session: MobileWebShellSession,
  cause: MobileWebShellUpdateFailureCause,
  restart: RestartFlow
): MobileWebShellStep {
  const linkLost = readFailureSide(cause.reason) === 'transport'
  if (linkLost && session.gates !== null && retriesNow(session, session.gates)) {
    return restart(session, session.gates)
  }
  return step(session, {
    state: { kind: 'failed', reason: 'download-failed', retriedOnce: session.retriedOnce },
    retryOnReconnect: linkLost
  })
}

// Restart only on a changed verdict so unchanged reconnect/status events cannot rerun the flow.
function reduceGatesChanged(
  session: MobileWebShellSession,
  gates: MobileWebShellGates,
  restart: RestartFlow
): MobileWebShellStep {
  const changed = session.gates === null || gateKey(session.gates) !== gateKey(gates)
  const waiting =
    awaitsGates(session.state) || (session.state.kind === 'failed' && retriesNow(session, gates))
  return changed && waiting ? restart(session, gates) : step(session, { gates })
}

// Wall-clock read limits can expire while away with the link still up, and fire just after the return; the verdict never leaves open, so no reconnect would retry.
function reduceAppForegrounded(
  session: MobileWebShellSession,
  restart: RestartFlow
): MobileWebShellStep {
  if (session.gates !== null && retriesNow(session, session.gates)) {
    return restart(session, session.gates)
  }
  return session.state.kind === 'fetching'
    ? step(session, { retryOnReconnect: true })
    : step(session, {})
}

function retriesNow(session: MobileWebShellSession, gates: MobileWebShellGates): boolean {
  return session.retryOnReconnect && gateVerdict(gates).kind === 'open'
}
