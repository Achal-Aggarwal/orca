import { isAgentForegroundWrapperProcess } from '../../../../shared/agent-process-recognition'
import type { ForegroundReadReason } from './pane-foreground-agent-tracker-contract'

export function shouldRetryForegroundAgentRead(
  hasConfirmationExpectation: boolean,
  reason: ForegroundReadReason,
  processName: string | null,
  retryDelay: number | undefined
): boolean {
  const shouldRetryExpectedIdentity =
    hasConfirmationExpectation && (reason !== 'command-finished' || processName === null)
  const shouldRetry =
    retryDelay !== undefined &&
    (shouldRetryExpectedIdentity ||
      (processName !== null &&
        (reason === 'command' || isAgentForegroundWrapperProcess(processName))))
  return shouldRetry
}
