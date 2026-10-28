import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { resolveImageAbsolutePath } from './markdown-preview-links'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { readLocalImagePreview } from './local-image-src-reader'
import type { LocalFileAccess } from '../../../../shared/local-file-access'
import {
  blobUrlCache,
  cacheLocalImageBlob,
  getLocalImageCacheGeneration,
  getLocalImageCacheKeyVersion,
  inFlightBlobUrlLoads,
  invalidateLocalImageCache,
  pinLocalImageCache,
  releaseLocalImageBlob,
  resetLocalImageCacheState,
  subscribeToLocalImageCacheInvalidation,
  unpinLocalImageCache
} from './local-image-src-cache'
import {
  acquireLocalImageDisplayLease,
  type LocalImageDisplayLease
} from './local-image-display-lease'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import {
  createLocalImageRead,
  hasLocalImageReadOwner,
  ownLocalImageRead,
  resetLocalImageReadAdmissionForTests
} from './local-image-read-admission'

export function getLocalImageCacheKey(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & {
    connectionId?: string | null
  },
  access?: LocalFileAccess
): string {
  const runtimeEnvironmentId = runtimeContext
    ? (runtimeTargetEnvironmentId(runtimeContext.target) ?? 'client')
    : 'client'
  return [
    runtimeEnvironmentId,
    runtimeContext?.connectionId ?? connectionId ?? 'local',
    runtimeContext?.expectedExecutionHostId ?? 'unknown-host',
    runtimeContext?.expectedSshTargetId ?? '',
    runtimeContext?.expectedSshConnectionGeneration?.toString() ?? '',
    runtimeContext?.expectedExternalSshTargetId ?? '',
    runtimeContext?.worktreeId ?? 'unknown-worktree',
    runtimeContext?.worktreePath ?? '',
    // Why: an image read under one access kind must never answer a request made under another.
    access?.kind ?? 'roots',
    access?.kind === 'document-resource' ? access.documentPath : '',
    absolutePath
  ].join('\0')
}

function base64ToBlobUrl(base64: string, mimeType: string): { url: string; byteLength: number } {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: mimeType })),
    byteLength: bytes.byteLength
  }
}

export const onImageCacheInvalidated = subscribeToLocalImageCacheInvalidation

function isExternalUrl(src: string): boolean {
  return /^(?:https?|data|blob):/i.test(src)
}

type LocalImageRuntimeContext = Omit<RuntimeFileOperationArgs, 'connectionId'> & {
  connectionId?: string | null
}

/** The cache identity of a local image, or null when it is external or has no owner yet. */
export function getLocalImageSrcCacheKey(
  rawSrc: string | undefined,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?: LocalImageRuntimeContext | null,
  access?: LocalFileAccess
): string | null {
  if (!rawSrc || isExternalUrl(rawSrc) || runtimeContext === null) {
    return null
  }
  const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
  return absolutePath
    ? getLocalImageCacheKey(absolutePath, connectionId, runtimeContext, access)
    : null
}

/** Resolve local images through IPC/blob URLs and revalidate on refocus; external URLs pass through. */
export function useLocalImageSrc(
  rawSrc: string | undefined,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?: LocalImageRuntimeContext | null,
  access?: LocalFileAccess,
  retryKey?: number
): string | undefined {
  const generation = useSyncExternalStore(onImageCacheInvalidated, getLocalImageCacheGeneration)
  const externalSrc =
    rawSrc && runtimeContext !== null && isExternalUrl(rawSrc) ? rawSrc : undefined
  // Key leases by semantic identity; equal rebuilt context objects must not revoke a still-displayed image URL.
  const cacheKey = getLocalImageSrcCacheKey(rawSrc, filePath, connectionId, runtimeContext, access)
  const readImage = useEffectEvent((signal: AbortSignal): Promise<string | null> => {
    const absolutePath = rawSrc ? resolveImageAbsolutePath(rawSrc, filePath) : null
    return absolutePath
      ? loadLocalImageAbsolutePath(absolutePath, connectionId, runtimeContext, access, signal)
      : Promise.resolve(null)
  })

  const [displayStore] = useState(() =>
    createStore<string | undefined>(
      () => externalSrc ?? (cacheKey ? blobUrlCache.get(cacheKey) : undefined)
    )
  )
  const displaySrc = useStore(displayStore)
  const displayLease = useRef<LocalImageDisplayLease | null>(null)
  const syncDisplayLease = useEffectEvent(
    (lease: LocalImageDisplayLease, nextSrc: string | undefined) => {
      lease.setDisplayedUrls([displaySrc, nextSrc].filter((url) => url !== undefined))
    }
  )
  const setDisplaySrc = useEffectEvent((nextSrc: string | undefined) => {
    if (displayLease.current) {
      syncDisplayLease(displayLease.current, nextSrc)
    }
    displayStore.setState(nextSrc)
  })

  useEffect(() => {
    const lease = displayLease.current ?? acquireLocalImageDisplayLease(cacheKey)
    displayLease.current = lease
    syncDisplayLease(lease, displayStore.getState())
    return () => {
      lease.release()
      displayLease.current = null
    }
  }, [cacheKey, displayStore])

  // Passive cleanup survives Suspense hiding; layout setup protects the first cached commit.
  useLayoutEffect(() => {
    displayLease.current ??= acquireLocalImageDisplayLease(cacheKey)
    syncDisplayLease(displayLease.current, displayStore.getState())
  }, [cacheKey, displaySrc, displayStore])

  useEffect(() => {
    if (externalSrc || !cacheKey) {
      setDisplaySrc(externalSrc)
      return
    }
    const cached = blobUrlCache.get(cacheKey)
    if (cached) {
      setDisplaySrc(cached)
      return
    }

    const controller = new AbortController()
    const effectGeneration = generation
    readImage(controller.signal)
      .then((url) => {
        if (controller.signal.aborted) {
          return
        }
        setDisplaySrc(getLocalImageCacheGeneration() === effectGeneration && url ? url : undefined)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDisplaySrc(undefined)
        }
      })

    return () => {
      controller.abort()
    }
  }, [cacheKey, externalSrc, generation, retryKey])

  return displaySrc
}

/** Load through the same IPC/blob cache outside React, including ProseMirror node views. */
export async function loadLocalImageSrc(
  rawSrc: string,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?:
    | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
    | null,
  access?: LocalFileAccess,
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) {
    return null
  }
  if (isExternalUrl(rawSrc)) {
    return rawSrc
  }
  if (runtimeContext === null) {
    return null
  }

  const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
  if (!absolutePath) {
    return null
  }

  const cacheKey = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext, access)
  const cached = blobUrlCache.get(cacheKey)
  if (cached) {
    return cached
  }

  return loadLocalImageAbsolutePath(absolutePath, connectionId, runtimeContext, access, signal)
}

export function loadLocalImageAbsolutePath(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?:
    | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
    | null,
  access?: LocalFileAccess,
  signal?: AbortSignal
): Promise<string | null> {
  if (runtimeContext === null || signal?.aborted) {
    return Promise.resolve(null)
  }
  const cacheKey = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext, access)
  const cached = blobUrlCache.get(cacheKey)
  if (cached) {
    return Promise.resolve(cached)
  }

  const inFlight = inFlightBlobUrlLoads.get(cacheKey)
  if (inFlight) {
    return ownLocalImageRead(cacheKey, inFlight, signal)
  }

  const readGeneration = getLocalImageCacheGeneration()
  const readLeaseVersion = getLocalImageCacheKeyVersion(cacheKey)
  const readOwnerKey = [
    runtimeContext ? (runtimeTargetEnvironmentId(runtimeContext.target) ?? 'client') : 'client',
    runtimeContext?.connectionId ?? connectionId ?? 'local',
    runtimeContext?.expectedExecutionHostId ?? 'local',
    runtimeContext?.expectedSshTargetId ?? '',
    runtimeContext?.expectedSshConnectionGeneration?.toString() ?? '',
    runtimeContext?.expectedExternalSshTargetId ?? ''
  ].join('\0')
  const loadPromise = createLocalImageRead(cacheKey, readOwnerKey, async (readSignal) => {
    const result = await readLocalImagePreview(absolutePath, connectionId, runtimeContext, access)
    if (
      readSignal.aborted ||
      !result.isBinary ||
      !result.content ||
      getLocalImageCacheGeneration() !== readGeneration
    ) {
      return null
    }
    const { url, byteLength } = base64ToBlobUrl(result.content, result.mimeType ?? 'image/png')
    if (getLocalImageCacheGeneration() !== readGeneration) {
      URL.revokeObjectURL(url)
      return null
    }
    return cacheLocalImageBlob(cacheKey, url, byteLength, readLeaseVersion) ? url : null
  })
  return ownLocalImageRead(cacheKey, loadPromise, signal)
}

export function resetLocalImageSrcStateForTests(): void {
  resetLocalImageReadAdmissionForTests()
  resetLocalImageCacheState()
}

export function invalidateLocalImageSrcCacheForTests(): void {
  invalidateLocalImageCache()
}

export function acquireLocalImageSrcLease(
  rawSrc: string | undefined,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?: LocalImageRuntimeContext | null,
  access?: LocalFileAccess
): (() => void) | undefined {
  const key = getLocalImageSrcCacheKey(rawSrc, filePath, connectionId, runtimeContext, access)
  if (!key) {
    return undefined
  }
  pinLocalImageCache(key)
  return () => unpinLocalImageCache(key)
}

/** Evict the image cached under a `getLocalImageSrcCacheKey` key unless a preview pins it. */
export const releaseLocalImageSrcByKey = releaseLocalImageBlob

export function releaseUnusedLocalImageSrcByKey(key: string): void {
  if (!hasLocalImageReadOwner(key)) {
    releaseLocalImageBlob(key)
  }
}
