import type { AgentHookSource } from '../agent-hook-relay'
import { normalizeHookEventName } from './provider-event-names'

// SessionStart entries are idle boundaries that clear previous-session caches (STA-3386), not turns.
const NEW_TURN_EVENTS: Record<AgentHookSource, readonly string[]> = {
  claude: ['SessionStart', 'UserPromptSubmit'],
  codex: ['SessionStart', 'UserPromptSubmit'],
  qoder: ['SessionStart', 'UserPromptSubmit'],
  'qoder-cn': ['SessionStart', 'UserPromptSubmit'],
  'qwen-code': ['SessionStart', 'UserPromptSubmit'],
  codebuddy: ['UserPromptSubmit'],
  kimi: ['UserPromptSubmit'],
  muse: ['UserPromptSubmit'],
  dsh: ['SessionStart', 'UserPromptSubmit'],
  zcode: ['SessionStart', 'UserPromptSubmit'],
  gemini: ['BeforeAgent'],
  antigravity: ['PreInvocation'],
  amp: ['agent.start'],
  opencode: ['SessionStart'],
  opencode2: ['SessionStart'],
  'mimo-code': [],
  cursor: ['beforeSubmitPrompt', 'sessionStart'],
  pi: ['before_agent_start'],
  omp: ['before_agent_start'],
  'prime-agent': ['before_agent_start'],
  droid: ['UserPromptSubmit'],
  'command-code': [],
  grok: ['user_prompt_submit'],
  copilot: [
    'SessionStart',
    'UserPromptSubmit',
    'sessionStart',
    'userPromptSubmitted',
    'userPromptSubmit'
  ],
  hermes: ['pre_llm_call', 'on_session_start'],
  devin: ['UserPromptSubmit'],
  jcode: ['turn_start'],
  kiro: ['agentSpawn', 'userPromptSubmit', 'UserPromptSubmit']
}
const SESSION_BOUNDARIES = new Set([
  'SessionStart',
  'sessionStart',
  'on_session_start',
  'agentSpawn'
])

// Session boundaries reset listener caches but cannot prove that a prompt was accepted.
export function hasAgentTurnStartHook(agent: string): boolean {
  return Object.entries(NEW_TURN_EVENTS).some(
    ([source, events]) => source === agent && events.some((event) => !SESSION_BOUNDARIES.has(event))
  )
}

export function isNewTurnEvent(source: AgentHookSource, eventName: unknown): boolean {
  const name = source === 'grok' ? normalizeHookEventName(eventName) : eventName
  return typeof name === 'string' && NEW_TURN_EVENTS[source].includes(name)
}
