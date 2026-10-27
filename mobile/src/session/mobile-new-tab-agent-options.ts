import type { AgentPickerEntry } from '../../../src/shared/agent-launch-picker'
import { orderAgentLaunchPickerAgents } from '../../../src/shared/agent-launch-picker-rows'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isMobileTuiAgent, MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'

export type MobileNewTabAgentSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: unknown
}

export type MobileNewTabAgentOption = {
  agent: TuiAgent
  label: string
  pickerSeed?: Pick<AgentPickerEntry, 'terminal' | 'structured' | 'arguments'> & {
    chatDefault: boolean
  }
}

export function orderMobileNewTabAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detectedAgents: Iterable<unknown>,
  disabledAgents?: unknown
): TuiAgent[] {
  return orderAgentLaunchPickerAgents(
    defaultAgent,
    [...detectedAgents].filter(isMobileTuiAgent),
    Array.isArray(disabledAgents) ? disabledAgents : undefined
  )
}

export function buildMobileNewTabAgentOptions(
  settings: MobileNewTabAgentSettings | null | undefined,
  detectedAgentIds: Iterable<unknown> | null
): MobileNewTabAgentOption[] {
  if (!detectedAgentIds) {
    return []
  }
  return orderMobileNewTabAgents(
    settings?.defaultTuiAgent,
    detectedAgentIds,
    settings?.disabledTuiAgents
  ).map((agent) => ({
    agent,
    label: MOBILE_TUI_AGENT_LABELS[agent]
  }))
}
