import { analyzeAgentChoiceArgs } from './agent-choice-args'
import { agentArgsSetPermission, analyzeAgentChoiceWords } from './agent-permission-args'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'
import type { AgentPickerDraft, AgentPickerEntry } from './agent-launch-picker'

/** Keep opaque Arguments literal; only separate spans the common analyzer can cut safely. */
export function agentPickerArgumentPermission(entry: AgentPickerEntry, draft: AgentPickerDraft) {
  const text = (draft.arguments === undefined ? entry.arguments : draft.arguments) ?? ''
  if (!agentArgsSetPermission(entry.agent, text)) {
    return undefined
  }
  const locked = draft.surface === 'terminal'
  const opaque = { flag: text, remainingArguments: text, locked, opaque: true }
  const parsed = tokenizeStartupCommand(text, 'posix')
  if (!parsed.ok) {
    return opaque
  }
  const { roles, carrierIndices } = analyzeAgentChoiceWords(entry.agent, parsed.tokens)
  if (!carrierIndices.length || carrierIndices.some((index) => roles[index] === 'uncertain')) {
    return opaque
  }
  const ranges = carrierIndices.map((index) => {
    const name = roles[index].slice('option:'.length)
    let end = index
    while (roles[end + 1] === `value:${name}`) {
      end++
    }
    return {
      key: 'permissionMode',
      value: '',
      start: parsed.spans[index].start,
      end: parsed.spans[end].end,
      lift: false
    }
  })
  const remainingArguments = analyzeAgentChoiceArgs(entry.agent, text).cut(ranges)
  return remainingArguments === null
    ? opaque
    : {
        flag: ranges.map(({ start, end }) => text.slice(start, end)).join(' '),
        remainingArguments,
        locked,
        opaque: false
      }
}
