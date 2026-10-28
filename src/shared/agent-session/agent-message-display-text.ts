import type { AgentMessageSource } from './agent-session-message-source'
import type { NativeChatBlock } from '../native-chat-types'
import { sha256 } from '../sha256'

/** Display only: queue edits, provider input and context readers retain the original blocks. */
export function agentMessageDisplayText(
  blocks: readonly NativeChatBlock[],
  from?: AgentMessageSource
): string {
  const texts = blocks.filter((block) => block.type === 'text')
  const text = texts.map((block) => block.text).join('\n')
  const instructions =
    from?.orchestration?.message === 'task' ? from.orchestration.instructions : undefined
  if (!instructions || texts.length !== 1 || instructions.length > text.length) return text
  const digest = Array.from(
    sha256(new TextEncoder().encode(text.slice(0, instructions.length))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
  return digest === instructions.sha256 ? text.slice(instructions.length) : text
}
