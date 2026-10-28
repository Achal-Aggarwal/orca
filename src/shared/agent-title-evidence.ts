import {
  CLAUDE_IDLE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  containsAgentSpinnerGlyph,
  isClaudeIdentityFrameSegment,
  isClaudeManagementTitle,
  isCursorNativeAgentTitle
} from './agent-title-core'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import { isDeepSeekBuildTerminalTitle } from './dsb-terminal-title'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import {
  getPiCompatibleSyntheticAgentLabel,
  getPiCompatibleTitleBrand,
  isLegacyPiCompatibleTitle
} from './pi-compatible-synthetic-title'
import { isDshTerminalTitle } from './dsh-terminal-title'
import { isQoderTerminalTitle } from './qoder-terminal-title'
import {
  SYNTHETIC_AGENT_TITLE_AGENTS,
  SYNTHETIC_AGENT_TITLE_PROFILES
} from './synthetic-agent-title'
import type { TerminalAgent } from './terminal-agent'
import {
  agentForNativeFrame,
  agentForOwnerSuffix,
  agentForWholeTitle,
  namesConsumedByAnchoredLabels,
  namesIn
} from './agent-title-name-anchoring'

/** Collect before ranking: anchored identity names outrank vendor glyphs, which outrank free-text mentions. Free text alone never identifies a pane; prefer no icon to a wrong one. Activity parsing handles generic busy signals separately. */
export type AgentTitleEvidenceReason =
  | 'anchored'
  | 'vendor-marker'
  | 'conflicting-anchored-names'
  | 'conflicting-vendor-markers'
  | 'free-text-only'
  | 'no-evidence'

export type AgentTitleEvidence = {
  readonly vendorMarkers: readonly TerminalAgent[]
  readonly anchoredNames: readonly TerminalAgent[]
  readonly freeTextNames: readonly TerminalAgent[]
  /** Null whenever the title cannot answer on its own. Callers fall back to stronger signals. */
  readonly agent: TerminalAgent | null
  readonly reason: AgentTitleEvidenceReason
}

const GEMINI_GLYPHS = [GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE, GEMINI_PERMISSION]
const ANTIGRAVITY_MODEL_TITLE_RE = /^(?:agy|antigravity)(?:\s*[\u00B7\u2014:-]\s*|\s+)gemini\s+\d/i

/** Orca owns the final - <agent> suffix. Require leading whitespace to avoid treating hyphenated cwd names as ownership. */
const OWNER_SUFFIX_RE = /\s-\s+([A-Za-z][\w-]*)\s*$/
const WRAPPER_SEPARATOR = ' | '
const MAX_WRAPPER_EVIDENCE_SEGMENTS = 8

function getEvidenceTitleSegments(title: string): string[] {
  const segments = [title]
  let separatorIndex = title.lastIndexOf(WRAPPER_SEPARATOR)
  while (separatorIndex >= 0 && segments.length < MAX_WRAPPER_EVIDENCE_SEGMENTS) {
    const wrapped = title.slice(separatorIndex + WRAPPER_SEPARATOR.length).trim()
    if (wrapped && !segments.includes(wrapped)) {
      segments.push(wrapped)
    }
    const previousSeparatorIndex = separatorIndex
    separatorIndex = title.lastIndexOf(WRAPPER_SEPARATOR, separatorIndex - 1)
    if (separatorIndex === previousSeparatorIndex) {
      break
    }
  }
  return segments
}

function agentForSyntheticTitle(text: string): TerminalAgent | null {
  const trimmed = text.trim()
  if (/[\\/]/.test(trimmed)) {
    return null
  }
  const normalized = trimmed.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase()
  for (const agent of SYNTHETIC_AGENT_TITLE_AGENTS) {
    const profile = SYNTHETIC_AGENT_TITLE_PROFILES[agent]
    const emittedLabels = [profile.permissionLabel, profile.idleLabel]
    if (profile.synthesizeWorkingTitle !== false) {
      // Working labels are emitted only as spinner frames; a bare name is free text.
      if (
        profile.synthesizeTerminalTitle !== false &&
        containsAgentSpinnerGlyph(trimmed) &&
        normalized === profile.workingLabel.toLowerCase()
      ) {
        return agent
      }
    }
    if (
      profile.synthesizeTerminalTitle !== false &&
      emittedLabels.some((label) => normalized === label.toLowerCase())
    ) {
      return agent
    }
  }
  return null
}

function collectVendorMarkers(segments: readonly string[]): TerminalAgent[] {
  const markers = new Set<TerminalAgent>()
  for (const segment of segments) {
    // Only a leading identity-position sigil counts; the same glyph inside task text is decoration.
    if (GEMINI_GLYPHS.some((glyph) => segment.startsWith(glyph))) {
      markers.add('gemini')
    }
    if (
      segment.startsWith(`${CLAUDE_IDLE} `) ||
      segment === CLAUDE_IDLE ||
      segment.startsWith('. ') ||
      segment.startsWith('* ')
    ) {
      markers.add('claude')
    }
    if (isCursorNativeAgentTitle(segment)) {
      markers.add('cursor')
    }
  }
  return [...markers]
}

function collectAnchoredNames(
  segments: readonly string[],
  vendorMarkers: readonly TerminalAgent[],
  nativeFrames: boolean
): TerminalAgent[] {
  const anchored = new Set<TerminalAgent>()
  // Why: a native owner's task text can end with DSB's product-name suffix, including inside wrappers.
  const nativeOpenCode = segments.some(isOpenCodeNativeTitle)
  const allowDsbTitle = vendorMarkers.length === 0 && !nativeOpenCode

  for (const segment of segments) {
    // Native wrapped titles own their envelope even when session text names other agents.
    if (isOpenCodeNativeTitle(segment)) {
      anchored.add('opencode')
    }
    if (allowDsbTitle && isDeepSeekBuildTerminalTitle(segment)) {
      anchored.add('dsb')
    }

    if (nativeFrames && !nativeOpenCode) {
      const native = agentForNativeFrame(segment)
      if (native) {
        anchored.add(native)
      }
      if (
        isDshTerminalTitle(segment) &&
        stripLeadingAgentTitleDecorationOrEmpty(segment).startsWith('🐋')
      ) {
        anchored.add('dsh')
      }
      if (isQoderTerminalTitle(segment)) {
        anchored.add(segment.includes('Qoder CLI CN') ? 'qoder-cn' : 'qoder')
      }
      const piBrand = getPiCompatibleTitleBrand(segment)
      if (piBrand || isLegacyPiCompatibleTitle(segment)) {
        anchored.add(piBrand === 'OMP' ? 'omp' : 'pi')
      }
    }

    const suffix = OWNER_SUFFIX_RE.exec(segment)
    if (suffix) {
      const agent = agentForOwnerSuffix(suffix[1])
      if (agent) {
        anchored.add(agent)
      }
    }

    // OpenCode owns its session envelope; only competing owner suffixes can conflict.
    if (nativeFrames && nativeOpenCode) {
      continue
    }

    // Strip the leading sigil to expose anchored names: in ✳ agy, the name outranks the inherited Claude glyph.
    const withoutSigil = segment.startsWith(`${CLAUDE_IDLE} `)
      ? segment.slice(CLAUDE_IDLE.length)
      : segment
    const bare = agentForWholeTitle(withoutSigil)
    if (bare) {
      anchored.add(bare)
    }
    const synthetic = agentForSyntheticTitle(segment)
    if (synthetic) {
      anchored.add(synthetic)
    }
    if (isClaudeIdentityFrameSegment(segment)) {
      anchored.add('claude')
    }

    // Parse agy identity plus Gemini model metadata structurally instead of giving Gemini a competitor-specific exception.
    const undecorated = stripLeadingAgentTitleDecorationOrEmpty(segment).trim()
    if (ANTIGRAVITY_MODEL_TITLE_RE.test(undecorated)) {
      anchored.add('antigravity')
    }

    const piCompatible = getPiCompatibleSyntheticAgentLabel(segment)
    if (piCompatible === 'Pi') {
      anchored.add('pi')
    } else if (piCompatible === 'OMP') {
      anchored.add('omp')
    }
  }

  return [...anchored]
}

/** Collects every identity signal in `title` and ranks them by class, never by declaration order. */
function collectTitleEvidence(title: string, nativeFrames: boolean): AgentTitleEvidence {
  const empty = { vendorMarkers: [], anchoredNames: [], freeTextNames: [] } as const
  if (!title.trim() || isClaudeManagementTitle(title)) {
    // Why: a `claude agents` management screen is Claude's own UI, not an agent session.
    return { ...empty, agent: null, reason: 'no-evidence' }
  }

  const segments = getEvidenceTitleSegments(title)
  const vendorMarkers = collectVendorMarkers(segments)
  const anchoredNames = collectAnchoredNames(segments, vendorMarkers, nativeFrames)
  const anchoredSet = new Set(anchoredNames)
  const anchoredLabelNames = namesConsumedByAnchoredLabels(segments, anchoredSet)
  const freeTextNames = namesIn(title).filter(
    (agent) => !anchoredSet.has(agent) && !anchoredLabelNames.has(agent)
  )
  const evidence = { vendorMarkers, anchoredNames, freeTextNames } as const

  if (anchoredNames.length === 1) {
    // Why anchored beats a vendor marker: `✳ agy` is an agy pane whose title kept Claude's sigil.
    return { ...evidence, agent: anchoredNames[0], reason: 'anchored' }
  }
  if (anchoredNames.length > 1) {
    return { ...evidence, agent: null, reason: 'conflicting-anchored-names' }
  }
  if (vendorMarkers.length > 1) {
    return { ...evidence, agent: null, reason: 'conflicting-vendor-markers' }
  }
  if (vendorMarkers.length === 1 && (!nativeFrames || vendorMarkers[0] !== 'claude')) {
    // Free-text names cannot veto a vendor glyph (✳ Fix Codex… is Claude); a conflicting anchored name already outranks it.
    return { ...evidence, agent: vendorMarkers[0], reason: 'vendor-marker' }
  }
  return {
    ...evidence,
    agent: null,
    reason: freeTextNames.length > 0 ? 'free-text-only' : 'no-evidence'
  }
}

/** Canonical host evidence retains its existing conservative title vocabulary. */
export function collectAgentTitleEvidence(title: string): AgentTitleEvidence {
  return collectTitleEvidence(title, false)
}

/** Hookless terminal readers also admit native named frames, but generic Claude activity cannot claim identity. */
export function collectExplicitAgentTitleEvidence(title: string): AgentTitleEvidence {
  return collectTitleEvidence(title, true)
}
