import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import type { RpcContext } from '../core'
import { clientRendersStructuredAgent } from './structured-agent-session-policy'

/** agent.launch.v2 declares support for both outcomes. CLI/runtime-socket and SSH bridges have no clientKind/capabilities; the desktop renderer is a runtime client and must advertise support. */
export function supportsAgentLaunch(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY) === true
  )
}

/** v2 covers Claude/Codex chats; other agents require the same explicit rendering capability used by tabs and restart offers, else use terminal. */
export function callerRendersLaunchedChat(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>,
  agent: string
): boolean {
  return (
    context.clientKind === undefined ||
    agent === 'claude' ||
    agent === 'codex' ||
    clientRendersStructuredAgent(context.clientCapabilities, agent)
  )
}
