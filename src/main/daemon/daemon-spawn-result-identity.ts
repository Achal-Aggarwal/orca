import type { PtySpawnResult } from '../providers/pty-provider-contract'
import type { CreateOrAttachResult } from './types'

export function daemonSpawnResultIdentity(
  result: CreateOrAttachResult
): Pick<
  PtySpawnResult,
  | 'incarnationId'
  | 'agentSessionEnsure'
  | 'launchAgent'
  | 'switchOutcomeUnknown'
  | 'switchCleanupWitness'
> {
  return {
    ...(result.switchCleanupWitness ? { switchCleanupWitness: result.switchCleanupWitness } : {}),
    ...(result.switchOutcomeUnknown ? { switchOutcomeUnknown: true as const } : {}),
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}),
    ...(result.launchAgent ? { launchAgent: result.launchAgent } : {})
  }
}
