// Main owns agent resume; show its published restored/unavailable outcome once per terminal start.

import { useAppStore } from '@/store'
import type { TerminalPaneResumeOutcome } from '@/store/terminals/terminal-state'
import { mainStartsPane } from './main-starts-pane'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { PtyConnectResult } from '../pty-transport-types'
import type { ReattachPayloadSession } from './reattach-payload-session'

import { resumeUnavailableBannerReason } from '../session-restored-banner-pane-state'

// Why session storage: a reload reattaches the same start, which showed its banner already.
const SHOWN_STARTS_KEY = 'orca.mainPaneResumeBannersShown'
/** This document's shown starts, for when session storage is unavailable. */
const shownHere = new Set<string>()

const startOf = ({ ptyId, ptyGeneration }: TerminalPaneResumeOutcome): string =>
  `${ptyId}#${ptyGeneration ?? ''}`

function readShownStarts(): string[] {
  try {
    const stored: unknown = JSON.parse(globalThis.sessionStorage.getItem(SHOWN_STARTS_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : []
  } catch {
    return []
  }
}

/** Notes `start` as shown, keeping the latest start per pane; false if it was already. */
function noteShown(start: string, scope: string): boolean {
  const shown = readShownStarts()
  if (shownHere.has(start) || shown.includes(start)) {
    return false
  }
  for (const key of shownHere) {
    if (key.startsWith(scope)) {
      shownHere.delete(key)
    }
  }
  shownHere.add(start)
  try {
    globalThis.sessionStorage.setItem(
      SHOWN_STARTS_KEY,
      JSON.stringify([...shown.filter((key) => !key.startsWith(scope)), start])
    )
  } catch {
    // Best effort: without storage a reload may show the banner once more.
  }
  return true
}

function startKey(session: ConnectPanePtySession | ReattachPayloadSession, start: string) {
  const scope = `${JSON.stringify([session.runtimeEnvironmentId ?? '', session.cacheKey])}:`
  return { scope, start: scope + start }
}

/** Both attach result and main's frame present the same start; neither owns another notice. */
export function showResumeUnavailableBanner(
  session: ConnectPanePtySession | ReattachPayloadSession,
  result: Partial<PtyConnectResult>
): void {
  const id = result.id ?? session.transport?.getPtyId()
  if (id) {
    const found = useAppStore.getState().terminalPaneResumeOutcomesByPaneKey?.[session.cacheKey]
    const key = startKey(
      session,
      found?.ptyId === id ? startOf(found) : `${id}#${result.incarnationId ?? ''}`
    )
    if (!noteShown(key.start, key.scope)) {
      return
    }
  }
  session.showSessionRestoredBanner(resumeUnavailableBannerReason(result))
}

/** Capture attach-time resume evidence: the window’s own result, or main’s restored outcome for the bound terminal published since attach began. */
export function attachResumeCheck(
  session: ConnectPanePtySession,
  windowResume: ColdRestoreAgentResumeStartup | null
): (ptyId: string, connected?: PtyConnectResult | string | void) => boolean {
  const outcomeNow = (): TerminalPaneResumeOutcome | undefined =>
    useAppStore.getState().terminalPaneResumeOutcomesByPaneKey[session.cacheKey]
  const mainStarts = !windowResume && mainStartsPane(session)
  const before = mainStarts ? outcomeNow() : undefined
  return (ptyId, connected) => {
    const result = typeof connected === 'object' && connected !== null ? connected : null
    if (!mainStarts) {
      return Boolean(windowResume) && !result?.agentResumeUnavailable
    }
    const attached = result?.id ?? ptyId
    const found = outcomeNow()
    return (
      found?.ptyId === attached &&
      found.outcome === 'restored' &&
      (before === undefined || startOf(before) !== startOf(found))
    )
  }
}

/** Show main’s start outcome once after attach; its binding frame precedes the reply on ordered IPC and applies before the reply settles. */
export function showMainPaneResumeOutcome(
  session: ConnectPanePtySession,
  ptyId: string,
  result?: PtyConnectResult | null
): void {
  if (!mainStartsPane(session)) {
    return
  }
  const outcomes = useAppStore.getState().terminalPaneResumeOutcomesByPaneKey
  const found = outcomes[session.cacheKey]
  const key = found ? startKey(session, startOf(found)) : null
  if (found?.ptyId === ptyId && key && noteShown(key.start, key.scope)) {
    session.showSessionRestoredBanner(
      found.outcome === 'resume-unavailable'
        ? resumeUnavailableBannerReason(result ?? undefined)
        : found.outcome
    )
  }
}
