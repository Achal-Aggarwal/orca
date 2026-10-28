import { pinLocalImageCache, unpinLocalImageCache } from './local-image-src-cache'
import {
  getLocalImageBlobLifetimeVersion,
  retainLocalImageBlobUrl
} from './local-image-blob-lifetimes'

export type LocalImageDisplayLease = {
  setDisplayedUrls: (urls: readonly string[]) => void
  release: () => void
}

export function acquireLocalImageDisplayLease(key: string | null): LocalImageDisplayLease {
  if (key) {
    pinLocalImageCache(key, 'display')
  }
  const version = getLocalImageBlobLifetimeVersion()
  const retainedUrls = new Map<string, () => void>()
  let released = false
  const setDisplayedUrls = (urls: readonly string[]): void => {
    if (released || version !== getLocalImageBlobLifetimeVersion()) {
      return
    }
    const nextUrls = new Set(urls)
    for (const url of nextUrls) {
      if (!retainedUrls.has(url)) {
        retainedUrls.set(url, retainLocalImageBlobUrl(url))
      }
    }
    for (const [url, release] of retainedUrls) {
      if (!nextUrls.has(url)) {
        retainedUrls.delete(url)
        release()
      }
    }
  }
  return {
    setDisplayedUrls,
    release: () => {
      if (released) {
        return
      }
      for (const release of retainedUrls.values()) {
        release()
      }
      retainedUrls.clear()
      released = true
      if (key && version === getLocalImageBlobLifetimeVersion()) {
        unpinLocalImageCache(key, 'display')
      }
    }
  }
}
