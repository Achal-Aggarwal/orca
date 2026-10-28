import { readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { WorktreeHeadIdentity } from '../../shared/worktree/types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  createGitHeadIdentityReader,
  readGitHeadMetadataFile as readTrimmedFile,
  UNREADABLE_GIT_HEAD as UNREADABLE,
  type ResolvedGitRefOids as ResolvedRefOids,
  type UnreadableGitHead as Unreadable
} from '../../shared/git-head-identity-reader'
import {
  FULL_HEAD_IDENTITY_SCOPE,
  headIdentityEntryKey,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'

// Keep refresh spawn-free: bounded metadata reads avoid Git subprocess pressure on terminal input.

// Bound parallel metadata reads without serial WSL/UNC round trips per worktree.
const HEAD_IDENTITY_READ_CONCURRENCY = 8

/** Cache scoped identities; unresolved reads must retry rather than becoming permanent misses. */
export type WorktreeHeadIdentityCache = {
  entries: Map<string, WorktreeHeadIdentity>
  /** Retain last verified identities for unreadable entries and retry them next pass. */
  unverified: Set<string>
  entryNames: string[] | null
  primary: WorktreeHeadIdentity | null
  primaryUnverified: boolean
}

export function createWorktreeHeadIdentityCache(): WorktreeHeadIdentityCache {
  return {
    entries: new Map(),
    unverified: new Set(),
    entryNames: null,
    primary: null,
    primaryUnverified: false
  }
}

export type GitCommonHeadIdentityRead = {
  identities: WorktreeHeadIdentity[]
  /** Incomplete listing/metadata reads cannot establish a full freshness checkpoint. */
  complete: boolean
}

async function readLinkedEntryIdentity(
  commonDirPath: string,
  entryName: string,
  reader: ReturnType<typeof createGitHeadIdentityReader>
): Promise<WorktreeHeadIdentity | null | Unreadable> {
  const entryPath = join(commonDirPath, 'worktrees', entryName)
  const gitdirContent = await readTrimmedFile(join(entryPath, 'gitdir'))
  if (gitdirContent === UNREADABLE) {
    return UNREADABLE
  }
  if (!gitdirContent) {
    return null
  }
  // `gitdir` holds `<worktree>/.git`, absolute or (with relative-path
  // worktrees) relative to the entry dir.
  const gitdirAbsolute = isAbsolute(gitdirContent) ? gitdirContent : join(entryPath, gitdirContent)
  return reader.read(join(entryPath, 'HEAD'), dirname(gitdirAbsolute))
}

// Transient listing failure is unknown; only a genuinely absent directory proves an empty catalog.
async function listLinkedEntryNames(commonDirPath: string): Promise<string[] | null> {
  try {
    const entries = await readdir(join(commonDirPath, 'worktrees'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
}

function knowsEveryScopedEntry(
  entryKeys: readonly string[],
  scope: WorktreeHeadIdentityScope
): boolean {
  if (scope.entryNames.size === 0) {
    return true
  }
  const known = new Set(entryKeys)
  return [...scope.entryNames].every((key) => known.has(key))
}

// Shared branches can move without sibling reflog events; replay resolved refs onto cached siblings, evicting unresolved ones.
function retargetCachedIdentity(
  identity: WorktreeHeadIdentity,
  resolved: ResolvedRefOids
): WorktreeHeadIdentity | null {
  if (identity.branch === null || !resolved.has(identity.branch)) {
    return identity
  }
  const oid = resolved.get(identity.branch) ?? null
  return oid === null ? null : { ...identity, head: oid }
}

function applyResolvedRefOids(cache: WorktreeHeadIdentityCache, resolved: ResolvedRefOids): void {
  if (resolved.size === 0) {
    return
  }
  for (const [name, identity] of cache.entries) {
    const next = retargetCachedIdentity(identity, resolved)
    if (next === null) {
      cache.entries.delete(name)
    } else if (next !== identity) {
      cache.entries.set(name, next)
    }
  }
  if (cache.primary) {
    cache.primary = retargetCachedIdentity(cache.primary, resolved)
  }
}

/** Read heads without Git subprocesses; cache plus scope narrows reads while incomplete results remain explicit. */
export async function readGitCommonHeadIdentities(
  commonDirPath: string,
  cache: WorktreeHeadIdentityCache = createWorktreeHeadIdentityCache(),
  scope: WorktreeHeadIdentityScope = FULL_HEAD_IDENTITY_SCOPE
): Promise<GitCommonHeadIdentityRead> {
  const reader = createGitHeadIdentityReader(commonDirPath)

  // Bare/custom Git directories cannot infer a primary checkout from the standard .git parent.
  if (basename(commonDirPath) !== '.git') {
    cache.primary = null
  } else if (scope.all || scope.primary || cache.primary === null || cache.primaryUnverified) {
    const primary = await reader.read(join(commonDirPath, 'HEAD'), dirname(commonDirPath))
    cache.primaryUnverified = primary === UNREADABLE
    if (primary !== UNREADABLE) {
      cache.primary = primary
    }
  }

  let entryNames = cache.entryNames
  let listingStale = false
  let relisted = false
  const relist = async (): Promise<void> => {
    relisted = true
    const listing = await listLinkedEntryNames(commonDirPath)
    if (listing === null) {
      listingStale = true
      return
    }
    listingStale = false
    entryNames = listing
    const present = new Set(listing)
    for (const name of cache.entries.keys()) {
      if (!present.has(name)) {
        cache.entries.delete(name)
      }
    }
    for (const name of cache.unverified) {
      if (!present.has(name)) {
        cache.unverified.delete(name)
      }
    }
  }
  if (entryNames === null || scope.all || scope.listing) {
    await relist()
  }
  if (entryNames === null) {
    // Failed initial listing must leave the memo unset for retry.
    return { identities: cache.primary ? [cache.primary] : [], complete: false }
  }

  let entryKeys = entryNames.map(headIdentityEntryKey)
  // A named entry absent from the memo proves the listing stale, not that no work is needed.
  if (!relisted && !knowsEveryScopedEntry(entryKeys, scope)) {
    await relist()
    entryKeys = entryNames.map(headIdentityEntryKey)
  }

  const staleNames = entryNames.filter(
    (name, index) =>
      scope.all ||
      !cache.entries.has(name) ||
      cache.unverified.has(name) ||
      scope.entryNames.has(entryKeys[index])
  )
  // Bound libuv fanout; publish in listing order rather than completion order.
  const reads = await mapWithConcurrency(staleNames, HEAD_IDENTITY_READ_CONCURRENCY, (name) =>
    readLinkedEntryIdentity(commonDirPath, name, reader)
  )
  staleNames.forEach((name, index) => {
    const identity = reads[index]
    if (identity === UNREADABLE) {
      cache.unverified.add(name)
      return
    }
    cache.unverified.delete(name)
    if (identity) {
      cache.entries.set(name, identity)
    } else {
      cache.entries.delete(name)
    }
  })
  applyResolvedRefOids(cache, reader.resolved)

  // Forget failed listings so the next scoped refresh still re-enumerates missed additions/removals.
  cache.entryNames = listingStale ? null : entryNames
  const identities: WorktreeHeadIdentity[] = cache.primary ? [cache.primary] : []
  for (const name of entryNames) {
    const identity = cache.entries.get(name)
    if (identity) {
      identities.push(identity)
    }
  }
  return {
    identities,
    complete: !listingStale && cache.unverified.size === 0 && !cache.primaryUnverified
  }
}
