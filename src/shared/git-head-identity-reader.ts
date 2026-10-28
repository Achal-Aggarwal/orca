import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorktreeHeadIdentity } from './worktree/types'

const MAX_SYMREF_DEPTH = 5
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export const UNREADABLE_GIT_HEAD = Symbol('unreadable')
export type UnreadableGitHead = typeof UNREADABLE_GIT_HEAD
export type ResolvedGitRefOids = Map<string, string | null>

export async function readGitHeadMetadataFile(
  filePath: string,
  signal?: AbortSignal
): Promise<string | null | UnreadableGitHead> {
  signal?.throwIfAborted()
  try {
    return (await readFile(filePath, { encoding: 'utf8', signal })).trim()
  } catch (error) {
    signal?.throwIfAborted()
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      ? null
      : UNREADABLE_GIT_HEAD
  }
}

async function readPackedRefs(
  commonDirPath: string,
  signal?: AbortSignal
): Promise<Map<string, string> | UnreadableGitHead> {
  const refs = new Map<string, string>()
  const content = await readGitHeadMetadataFile(join(commonDirPath, 'packed-refs'), signal)
  if (content === UNREADABLE_GIT_HEAD) {
    return UNREADABLE_GIT_HEAD
  }
  if (content === null) {
    return refs
  }
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) {
      continue
    }
    const separator = line.indexOf(' ')
    if (separator > 0) {
      refs.set(line.slice(separator + 1).trim(), line.slice(0, separator))
    }
  }
  return refs
}

function isSafeRefName(ref: string): boolean {
  return (
    ref.length > 0 &&
    !ref.includes('\\') &&
    !ref.includes(':') &&
    !ref.split('/').some((part) => part === '..' || part === '')
  )
}

function asObjectId(value: string | null | undefined): string | null {
  return value != null && OBJECT_ID_PATTERN.test(value) ? value : null
}

async function resolveRefToOid(
  commonDirPath: string,
  ref: string,
  packedRefs: () => Promise<Map<string, string> | UnreadableGitHead>,
  signal?: AbortSignal
): Promise<string | null | UnreadableGitHead> {
  let current = ref
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
    if (!isSafeRefName(current)) {
      return null
    }
    const loose = await readGitHeadMetadataFile(join(commonDirPath, ...current.split('/')), signal)
    if (loose === UNREADABLE_GIT_HEAD) {
      return UNREADABLE_GIT_HEAD
    }
    if (loose === null) {
      const packed = await packedRefs()
      return packed === UNREADABLE_GIT_HEAD ? UNREADABLE_GIT_HEAD : asObjectId(packed.get(current))
    }
    if (loose.startsWith('ref: ')) {
      current = loose.slice('ref: '.length).trim()
      continue
    }
    return asObjectId(loose)
  }
  return null
}

export function createGitHeadIdentityReader(commonDirPath: string, signal?: AbortSignal) {
  let packedRefsPromise: Promise<Map<string, string> | UnreadableGitHead> | null = null
  const packedRefs = () => (packedRefsPromise ??= readPackedRefs(commonDirPath, signal))
  const resolved: ResolvedGitRefOids = new Map()

  return {
    resolved,
    async read(
      headFilePath: string,
      worktreePath: string
    ): Promise<WorktreeHeadIdentity | null | UnreadableGitHead> {
      const head = await readGitHeadMetadataFile(headFilePath, signal)
      if (head === UNREADABLE_GIT_HEAD) {
        return UNREADABLE_GIT_HEAD
      }
      if (!head) {
        return null
      }
      if (head.startsWith('ref: ')) {
        const ref = head.slice('ref: '.length).trim()
        const oid = await resolveRefToOid(commonDirPath, ref, packedRefs, signal)
        if (oid === UNREADABLE_GIT_HEAD) {
          return UNREADABLE_GIT_HEAD
        }
        resolved.set(ref, oid)
        return oid ? { worktreePath, head: oid, branch: ref } : null
      }
      const detachedOid = asObjectId(head)
      return detachedOid ? { worktreePath, head: detachedOid, branch: null } : null
    }
  }
}
