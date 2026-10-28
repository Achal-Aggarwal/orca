import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { rescanTrustedCodexSessionResume } from './codex-session-resume-rescan'

// Only the dated rollout layout may establish credential provenance.
const CLAIMED_CODEX_ROLLOUT_TAIL = String.raw`\d{4}/\d{2}/\d{2}/rollout-[^/]+\.jsonl(?:\.zst)?`
const TRUSTED_CODEX_ROLLOUT_TAIL = String.raw`\d{4}/\d{2}/\d{2}/rollout-[^/:]+\.jsonl(?:\.zst)?`
const ROLLOUT_RELATIVE_PATH = new RegExp(`^${TRUSTED_CODEX_ROLLOUT_TAIL}$`)
// Match the case folding used for trusted Windows homes.
const CODEX_ROLLOUT_LAYOUT_PATH = new RegExp(`(?:^|/)sessions/${CLAIMED_CODEX_ROLLOUT_TAIL}$`, 'i')

/** Unverified provenance starts fresh; claimed Codex layout controls the rejection notice. */
export type CodexSessionResumePreparation =
  | { outcome: 'resume'; codexHomePath: string; reconcileSharedRuntimeAuth?: boolean }
  | { outcome: 'fresh'; claimedCodexProvenance: boolean }

// Only fold extended drive paths; reject device namespaces and extended UNC paths.
function toCodexTrustedPathComparisonCopy(filePath: string): string | null {
  if (filePath.startsWith('\\\\.\\')) {
    return null
  }
  if (!filePath.startsWith('\\\\?\\')) {
    return filePath
  }
  return filePath.match(/^\\\\\?\\([A-Za-z]:[\\/][\s\S]*)$/)?.[1] ?? null
}

/** Returns the `YYYY/MM/DD/rollout-*.jsonl` tail, or null outside the dated layout. */
export function codexDatedRolloutRelativePath(
  sessionsRoot: string,
  filePath: string
): string | null {
  const comparisonSessionsRoot = toCodexTrustedPathComparisonCopy(sessionsRoot)
  const comparisonFilePath = toCodexTrustedPathComparisonCopy(filePath)
  if (!comparisonSessionsRoot || !comparisonFilePath) {
    return null
  }
  // Windows-syntax suffixes come back with `/` separators; POSIX keeps `\` as a name byte.
  const relativePath = relativePathInsideRoot(comparisonSessionsRoot, comparisonFilePath)
  return relativePath && ROLLOUT_RELATIVE_PATH.test(relativePath) ? relativePath : null
}

function isCodexRolloutInsideSessionsRoot(sessionsRoot: string, filePath: string): boolean {
  return codexDatedRolloutRelativePath(sessionsRoot, filePath) !== null
}

function isRegularFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile()
  } catch {
    return false
  }
}

function resolveExistingRolloutPath(
  transcriptPath: string,
  fileIsRegular: (filePath: string) => boolean
): string | null {
  const plainPath = transcriptPath.endsWith('.jsonl.zst')
    ? transcriptPath.slice(0, -'.zst'.length)
    : transcriptPath.endsWith('.jsonl')
      ? transcriptPath
      : null
  if (!plainPath) {
    return fileIsRegular(transcriptPath) ? transcriptPath : null
  }
  if (fileIsRegular(plainPath)) {
    return plainPath
  }
  const compressedPath = `${plainPath}.zst`
  return fileIsRegular(compressedPath) ? compressedPath : null
}

function resolveTrustedCodexSessionResume(args: {
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  fileIsRegular?: (filePath: string) => boolean
}): { homePath: string; transcriptPath: string } | null {
  const persistedPath = args.transcriptPath?.trim()
  if (!persistedPath) {
    return null
  }

  for (const homePath of args.trustedCodexHomes) {
    const sessionsRoot = join(homePath, 'sessions')
    if (!isCodexRolloutInsideSessionsRoot(sessionsRoot, persistedPath)) {
      continue
    }
    const transcriptPath = resolveExistingRolloutPath(
      persistedPath,
      args.fileIsRegular ?? isRegularFile
    )
    if (transcriptPath) {
      return { homePath, transcriptPath }
    }
  }
  return null
}

export function trustedCodexResumeHomes(
  runtimeHome: { getHostCodexHomePathsForSessionDiscovery(): string[] },
  systemHomePath: string
): string[] {
  // Import-only history sources cannot become CODEX_HOME or bypass account auth.
  return [systemHomePath, ...runtimeHome.getHostCodexHomePathsForSessionDiscovery()]
}

export function resolveTrustedCodexSessionResumeHome(args: {
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  fileIsRegular?: (filePath: string) => boolean
}): string | null {
  return resolveTrustedCodexSessionResume(args)?.homePath ?? null
}

/** Recognize rejected Codex provenance even under a removed or untrusted home. */
export function claimsCodexRolloutLayout(transcriptPath: string | undefined): boolean {
  const persistedPath = transcriptPath?.trim()
  if (!persistedPath) {
    return false
  }
  return CODEX_ROLLOUT_LAYOUT_PATH.test(persistedPath.replace(/\\/g, '/'))
}

export async function resolveCodexSessionResumeProvenance(args: {
  sessionId: string
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  getSelectedAccountCodexHome: () => string | null
  systemCodexHomePath: string | null
  sharedRuntimeCodexHomePath: string | null
  fileIsRegular?: (filePath: string) => boolean
  listSessionFiles?: (sessionsRoot: string) => AsyncIterable<string>
}): Promise<
  | { outcome: 'resume'; homePath: string; transcriptPath: string }
  | { outcome: 'fresh'; claimedCodexProvenance: boolean }
> {
  const sessionSource = await findTrustedCodexSessionResume(args)
  return sessionSource
    ? { outcome: 'resume', ...sessionSource }
    : { outcome: 'fresh', claimedCodexProvenance: claimsCodexRolloutLayout(args.transcriptPath) }
}

export async function findTrustedCodexSessionResume(args: {
  sessionId: string
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  getSelectedAccountCodexHome: () => string | null
  systemCodexHomePath: string | null
  sharedRuntimeCodexHomePath: string | null
  fileIsRegular?: (filePath: string) => boolean
  listSessionFiles?: (sessionsRoot: string) => AsyncIterable<string>
}): Promise<{ homePath: string; transcriptPath: string } | null> {
  const directSession = resolveTrustedCodexSessionResume(args)
  if (directSession) {
    return directSession
  }
  if (args.transcriptPath?.trim()) {
    // Rejected provenance must not fall back to a same-ID rollout under another account.
    return null
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.sessionId)) {
    return null
  }

  return rescanTrustedCodexSessionResume(args)
}
