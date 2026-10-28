import { PrioritySemaphore } from '../../../../shared/priority-semaphore'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import {
  cleanupLocalImageCacheKeyVersion,
  getLocalImageCacheGeneration,
  inFlightBlobUrlLoads,
  subscribeToLocalImageCacheInvalidation
} from './local-image-src-cache'

const LOCAL_IMAGE_READ_CONCURRENCY = 4
type ImageReadOwner = { admission: PrioritySemaphore; requests: number }
const owners = new Map<string, ImageReadOwner>()

async function runLocalImageRead<T>(
  ownerKey: string,
  signal: AbortSignal,
  read: () => Promise<T>
): Promise<T> {
  let owner = owners.get(ownerKey)
  if (!owner) {
    owner = { admission: new PrioritySemaphore(LOCAL_IMAGE_READ_CONCURRENCY), requests: 0 }
    owners.set(ownerKey, owner)
  }
  owner.requests += 1
  let release: (() => void) | undefined
  try {
    release = await owner.admission.acquire(0, signal)
    if (signal.aborted) {
      throw signal.reason
    }
    return await read()
  } finally {
    release?.()
    owner.requests -= 1
    if (owner.requests === 0 && owners.get(ownerKey) === owner) {
      owners.delete(ownerKey)
    }
  }
}

export function resetLocalImageReadAdmissionForTests(): void {
  for (const controller of imageReadControllers) {
    controller.abort()
  }
  imageReadControllers.clear()
  owners.clear()
}

type LocalImageReadOwnership = {
  controller: AbortController
  users: number
  persistent: boolean
}
const imageReadOwnership = new WeakMap<Promise<string | null>, LocalImageReadOwnership>()
const imageReadControllers = new Set<AbortController>()

export function hasLocalImageReadOwner(cacheKey: string): boolean {
  const pending = inFlightBlobUrlLoads.get(cacheKey)
  const ownership = pending ? imageReadOwnership.get(pending) : undefined
  return Boolean(
    ownership &&
    !ownership.controller.signal.aborted &&
    (ownership.persistent || ownership.users > 0)
  )
}

export function ownLocalImageRead(
  cacheKey: string,
  promise: Promise<string | null>,
  signal?: AbortSignal
): Promise<string | null> {
  const ownership = imageReadOwnership.get(promise)
  if (!ownership) {
    return promise
  }
  if (!signal) {
    ownership.persistent = true
    return promise
  }
  ownership.users += 1
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    ownership.users -= 1
    if (ownership.users === 0 && !ownership.persistent) {
      ownership.controller.abort()
      if (inFlightBlobUrlLoads.get(cacheKey) === promise) {
        inFlightBlobUrlLoads.delete(cacheKey)
      }
    }
  }
  signal.addEventListener('abort', release, { once: true })
  return waitForPromiseWithSignal(promise, signal)
    .catch(() => null)
    .finally(() => {
      signal.removeEventListener('abort', release)
      release()
    })
}

export function createLocalImageRead(
  cacheKey: string,
  ownerKey: string,
  read: (signal: AbortSignal) => Promise<string | null>
): Promise<string | null> {
  const controller = new AbortController()
  imageReadControllers.add(controller)
  const generation = getLocalImageCacheGeneration()
  const unsubscribe = subscribeToLocalImageCacheInvalidation(() => {
    if (getLocalImageCacheGeneration() !== generation) {
      controller.abort()
    }
  })
  const promise = runLocalImageRead(ownerKey, controller.signal, () => read(controller.signal))
    .catch(() => null)
    .finally(() => {
      unsubscribe()
      imageReadControllers.delete(controller)
      if (inFlightBlobUrlLoads.get(cacheKey) === promise) {
        inFlightBlobUrlLoads.delete(cacheKey)
      }
      cleanupLocalImageCacheKeyVersion(cacheKey)
    })
  inFlightBlobUrlLoads.set(cacheKey, promise)
  imageReadOwnership.set(promise, { controller, users: 0, persistent: false })
  return promise
}
