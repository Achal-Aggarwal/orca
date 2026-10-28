import {
  getMarkdownRichModeEligibilityDecision,
  resolveMarkdownRichModeUnsupportedMessage,
  type MarkdownRichModeEligibility,
  type MarkdownRichModeEligibilityDecision
} from './markdown-rich-mode'

type EligibilityCacheEntry = {
  content: string
  sizeOverridden: boolean
  decision: MarkdownRichModeEligibilityDecision
}

// Retain split-pane siblings so visible surfaces do not evict each other on every render.
const MAX_ENTRIES = 4
const MAX_SHARED_CONTENT_CHARACTERS = 128 * 1024

const entries: EligibilityCacheEntry[] = []
let ownerEntries = new WeakMap<object, EligibilityCacheEntry>()

/** Cache whole-document classification by content across rerenders; resolve messages per read so language changes stay current. */
export function getCachedMarkdownRichModeEligibility(params: {
  content: string
  sizeOverridden: boolean
  cacheOwner?: object
}): MarkdownRichModeEligibility {
  const decision = getCachedMarkdownRichModeEligibilityDecision(params)
  return {
    exceedsSizeLimit: decision.exceedsSizeLimit,
    unsupportedMessage: resolveMarkdownRichModeUnsupportedMessage(decision.unsupportedReason)
  }
}

function getCachedMarkdownRichModeEligibilityDecision(params: {
  content: string
  sizeOverridden: boolean
  cacheOwner?: object
}): MarkdownRichModeEligibilityDecision {
  const { content, sizeOverridden, cacheOwner } = params
  if (content.length > MAX_SHARED_CONTENT_CHARACTERS) {
    const entry = cacheOwner ? ownerEntries.get(cacheOwner) : undefined
    if (entry?.sizeOverridden === sizeOverridden && entry.content === content) {
      return entry.decision
    }
    const decision = getMarkdownRichModeEligibilityDecision({ content, sizeOverridden })
    if (cacheOwner) {
      // Large sources live only as long as the loaded file that already owns their text.
      ownerEntries.set(cacheOwner, { content, sizeOverridden, decision })
    }
    return decision
  }
  if (cacheOwner) {
    ownerEntries.delete(cacheOwner)
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.sizeOverridden !== sizeOverridden || entry.content !== content) {
      continue
    }
    if (index > 0) {
      entries.splice(index, 1)
      entries.unshift(entry)
    }
    return entry.decision
  }

  const decision = getMarkdownRichModeEligibilityDecision({ content, sizeOverridden })
  entries.unshift({ content, sizeOverridden, decision })
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES
  }
  return decision
}

export function resetMarkdownRichModeEligibilityCache(): void {
  entries.length = 0
  ownerEntries = new WeakMap()
}
