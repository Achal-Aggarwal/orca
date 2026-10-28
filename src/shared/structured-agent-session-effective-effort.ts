import type { CatalogOption } from './agent-session-option-catalog'

export const PI_THINKING_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const
const rank = (level: string): number => PI_THINKING_LEVELS.indexOf(level === 'none' ? 'off' : level)

/** Exact support, otherwise nearest with the higher level on a tie. */
export function nearestAgentEffort(
  previous: string,
  supported: readonly string[]
): string | undefined {
  if (supported.includes(previous)) {
    return previous
  }
  if (rank(previous) === -1) {
    return undefined
  }
  return supported
    .filter((level) => rank(level) !== -1)
    .sort(
      (a, b) =>
        Math.abs(rank(a) - rank(previous)) - Math.abs(rank(b) - rank(previous)) || rank(b) - rank(a)
    )[0]
}

export function catalogEffortLevels(controls: readonly CatalogOption[]): string[] | undefined {
  const effort = controls.find((option) => option.id === 'effort')
  return effort?.kind.type === 'select'
    ? effort.kind.choices.map((choice) => choice.value)
    : undefined
}

/** Seeds use nearest; an opaque Pi record keeps native higher-first application. Unknown support preserves intent. */
export function effectiveAgentEffort(
  effort: string | undefined,
  supported: readonly string[] | undefined,
  policy: 'nearest' | 'higher-first'
): string | undefined {
  if (!effort || !supported?.length || supported.includes(effort) || rank(effort) === -1) {
    return effort
  }
  if (policy === 'nearest') {
    return nearestAgentEffort(effort, supported) ?? effort
  }
  const ranked = supported.filter((level) => rank(level) !== -1).sort((a, b) => rank(a) - rank(b))
  return ranked.find((level) => rank(level) >= rank(effort)) ?? ranked.at(-1) ?? effort
}
