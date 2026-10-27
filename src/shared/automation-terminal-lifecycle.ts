/** Local desktop IPC only; resume records stay with the ordinary session owner. */
export type AutomationTerminalTarget = {
  worktreeId: string
  tabId: string
  leafId: string
  paneKey: string
}

export type AutomationTerminalCorrelation = {
  requestId: string
  registrationId: string
  runId: string
  operationId: string
  serviceGeneration: string
  documentEpoch: string | null
}

export type AutomationTerminalLifecycleRequest = AutomationTerminalCorrelation &
  (
    | { operation: 'arm'; target: AutomationTerminalTarget }
    | { operation: 'bind'; ptyId: string; incarnationId: string; hostId: string }
    | { operation: 'finalize'; phase: 'prepare'; preservePane: boolean }
    | { operation: 'finalize'; phase: 'authorize' }
    | { operation: 'finalize'; phase: 'stop-settled'; proof: 'stopped' | 'live' | 'unproven' }
    | { operation: 'release' }
  )

export type AutomationTerminalLifecycleResponse = AutomationTerminalCorrelation & {
  disposition:
    | 'armed'
    | 'bound'
    | 'prepared'
    | 'authorized'
    | 'released'
    | 'kept'
    | 'closed'
    | 'hibernated'
    | 'kept-live'
    | 'stopped-but-uncommitted'
    | 'unproven'
}

export function automationTerminalLifecycleResponse(
  request: AutomationTerminalLifecycleRequest,
  documentEpoch: string,
  disposition: AutomationTerminalLifecycleResponse['disposition']
): AutomationTerminalLifecycleResponse {
  return { ...request, documentEpoch, disposition }
}

export function isCurrentAutomationTerminalRequest<
  T extends { request: AutomationTerminalCorrelation }
>(
  owner: T | undefined,
  request: AutomationTerminalLifecycleRequest,
  documentEpoch: string
): owner is T {
  return (
    !!owner &&
    (request.documentEpoch === documentEpoch || request.operation === 'release') &&
    owner.request.runId === request.runId &&
    owner.request.operationId === request.operationId &&
    owner.request.serviceGeneration === request.serviceGeneration
  )
}

export type AutomationTerminalLifecycleOwner<Ownership> = {
  request: AutomationTerminalLifecycleRequest
  target: AutomationTerminalTarget
  ownership: Ownership
  ptyId: string | null
  prepared: boolean
  transactionCurrent?: () => boolean
  authorized: boolean
  proof?: 'stopped' | 'live' | 'unproven'
  settle?: (proof: 'stopped' | 'live' | 'unproven') => void
  completion?: Promise<AutomationTerminalLifecycleResponse['disposition']>
}
