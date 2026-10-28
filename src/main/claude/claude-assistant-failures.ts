import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'

/** Associates the assistant's typed error with its duplicate result, never with error text. */
export class ClaudeAssistantFailures {
  private readonly shown = new BoundedMap<string, true>({ maxEntries: 128 })
  constructor(
    private readonly account?: () => AgentSessionAccountKind | undefined,
    private readonly model?: () => string | undefined
  ) {}

  assistant(message: Record<string, unknown>) {
    const unavailable =
      message.error === 'model_not_found' && (message.parent_tool_use_id ?? null) === null
    if (
      message.type !== 'assistant' ||
      (!unavailable && message.error !== 'authentication_failed')
    ) {
      return null
    }
    const content = claudeRecord(message.message)?.content
    const text = Array.isArray(content)
      ? content
          .flatMap((part) => {
            const value = claudeRecord(part)
            return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
          })
          .join('\n')
      : ''
    const key = this.key(message) ?? (unavailable ? this.scopeKey(message) : null)
    if (key) {
      this.shown.set(key, true)
    }
    return {
      kind: 'status' as const,
      tone: 'error' as const,
      ...agentSessionFailureWords(
        agentSessionFailureFact(unavailable ? 'modelUnavailable' : 'notSignedIn', {
          account: this.account?.(),
          detail: unavailable
            ? providerDiagnostic(this.model?.() ?? 'this model', 'log')
            : providerDiagnostic(text, 'person')
        }),
        { agentName: 'Claude', provider: 'claude', surface: 'row' }
      )
    }
  }

  resultAlreadyShown(message: Record<string, unknown>): boolean {
    const exact = this.key(message)
    const key = exact && this.shown.has(exact) ? exact : this.scopeKey(message)
    if (!key || !this.shown.has(key)) {
      return false
    }
    this.shown.delete(key)
    return message.is_error === true
  }

  private scopeKey(message: Record<string, unknown>): string {
    return JSON.stringify([message.session_id, message.parent_tool_use_id ?? null])
  }

  private key(message: Record<string, unknown>): string | null {
    const uuid = claudeText(message.user_message_uuid)
    return uuid
      ? JSON.stringify([message.session_id, message.parent_tool_use_id ?? null, uuid])
      : null
  }
}
