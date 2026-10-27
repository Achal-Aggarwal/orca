import { findOptionOccurrence } from './command-option-occurrence'
import {
  tokenizeCustomCommandTemplate,
  type CommandTemplateBackslash
} from './commit-message-prompt'

export function planAdditionalAgentArgs(
  agentArgs: string | null | undefined,
  backslash: CommandTemplateBackslash = 'escape'
): { ok: true; args: string[] } | { ok: false; error: string } {
  const trimmed = agentArgs?.trim()
  if (!trimmed) {
    return { ok: true, args: [] }
  }
  const tokenized = tokenizeCustomCommandTemplate(trimmed, backslash)
  if (!tokenized.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${tokenized.error}` }
  }
  return { ok: true, args: tokenized.tokens }
}

export const KIMI_VALUE_OPTIONS = [
  '--prompt',
  '-p',
  '--model',
  '-m',
  '--output-format',
  '--skills-dir',
  '--agent',
  '--agent-file',
  '--add-dir'
]

export function findRecipeOption(
  tokens: readonly string[],
  aliases: readonly string[],
  valueOptions: readonly string[],
  startIndex = 0,
  stopAtTerminator = true
) {
  return findOptionOccurrence(
    tokens,
    aliases,
    stopAtTerminator,
    valueOptions,
    startIndex,
    valueOptions.length ? 'required' : true
  )
}

export function removeAllOptionOccurrences(
  tokens: string[],
  aliases: readonly string[],
  valueOptions: readonly string[] = []
): string[] {
  let result = tokens
  while (true) {
    const found = findRecipeOption(result, aliases, valueOptions)
    if (!found) {
      return result
    }
    result = [...result.slice(0, found.index), ...result.slice(found.index + found.consumed)]
  }
}
