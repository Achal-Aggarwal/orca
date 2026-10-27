import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import type { RpcContext } from '../core'
export { callerRendersLaunchedChat } from './agent-launch-caller-selection'

/** agent.launch.v2 declares support for both outcomes. CLI/runtime-socket and SSH bridges have no clientKind/capabilities; the desktop renderer is a runtime client and must advertise support. */
export function supportsAgentLaunch(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY) === true
  )
}
