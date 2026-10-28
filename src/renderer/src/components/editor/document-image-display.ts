import type { LocalFileAccess } from '../../../../shared/local-file-access'
import { observeViewportVisibility } from '@/lib/viewport-visibility'
import type { RichMarkdownImageRuntimeContext } from './rich-markdown-image-context'
import {
  acquireLocalImageSrcLease,
  getLocalImageSrcCacheKey,
  loadLocalImageSrc,
  onImageCacheInvalidated,
  releaseUnusedLocalImageSrcByKey
} from './useLocalImageSrc'
import {
  hasLocalImageCacheCapacity,
  isLocalImageCacheCapacityBlocked,
  subscribeToLocalImageCacheCapacity
} from './local-image-src-cache'

export type DocumentImageSource = {
  src: string | undefined
  filePath: string
  runtimeContext?: RichMarkdownImageRuntimeContext | null
  access?: LocalFileAccess
  resolvedSrc?: string
}

type ImageSize = { width: number; height: number }

function positiveDimension(value: string | null): number | undefined {
  const dimension = value ? Number(value) : 0
  return Number.isFinite(dimension) && dimension > 0 ? dimension : undefined
}

export function createDocumentImageDisplay(
  element: HTMLElement,
  image: HTMLImageElement,
  initialSource: DocumentImageSource
): {
  update: (source: DocumentImageSource) => void
  updateLayout: () => void
  destroy: () => void
} {
  let source = initialSource
  let key: string | null = null
  let identity = ''
  let visible = false
  let destroyed = false
  let placeholder = false
  let naturalSize: ImageSize | undefined
  let renderedSize: ImageSize | undefined
  let controller: AbortController | undefined
  let releaseLease: (() => void) | undefined
  let stopObserving: (() => void) | undefined
  let stopWaitingForCapacity: (() => void) | undefined

  const clearPlaceholder = (): void => {
    placeholder = false
    element.classList.remove('document-image-placeholder')
    element.style.removeProperty('width')
    element.style.removeProperty('height')
    element.style.removeProperty('aspect-ratio')
  }

  const updateLayout = (): void => {
    if (!placeholder) {
      return
    }
    const width = positiveDimension(image.getAttribute('width'))
    const height = positiveDimension(image.getAttribute('height'))
    const size = width && height ? { width, height } : (naturalSize ?? renderedSize)
    const displayWidth = image.style.width || (width ? `${width}px` : size ? `${size.width}px` : '')
    element.style.width = displayWidth
    element.style.height = image.style.height === 'auto' ? '' : image.style.height
    element.style.aspectRatio =
      image.style.aspectRatio || (size ? `${size.width} / ${size.height}` : '')
    element.classList.toggle(
      'document-image-placeholder',
      Boolean(displayWidth && (size || image.style.height))
    )
  }

  const holdLayout = (): void => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      naturalSize = { width: image.naturalWidth, height: image.naturalHeight }
    }
    if (!naturalSize) {
      const bounds = image.getBoundingClientRect()
      if (bounds.width > 0 && bounds.height > 0) {
        renderedSize = { width: bounds.width, height: bounds.height }
      }
    }
    placeholder = true
    updateLayout()
  }

  const stopRead = (evict: boolean): void => {
    controller?.abort()
    controller = undefined
    stopWaitingForCapacity?.()
    stopWaitingForCapacity = undefined
    releaseLease?.()
    releaseLease = undefined
    if (evict && key) {
      releaseUnusedLocalImageSrcByKey(key)
    }
  }

  const load = (): void => {
    if (destroyed || controller || !visible || !key || !source.src) {
      return
    }
    stopWaitingForCapacity?.()
    stopWaitingForCapacity = undefined
    releaseLease ??= acquireLocalImageSrcLease(
      source.src,
      source.filePath,
      undefined,
      source.runtimeContext,
      source.access
    )
    const loadController = new AbortController()
    controller = loadController
    void loadLocalImageSrc(
      source.src,
      source.filePath,
      undefined,
      source.runtimeContext,
      source.access,
      loadController.signal
    ).then((resolved) => {
      if (loadController.signal.aborted || destroyed || controller !== loadController) {
        return
      }
      controller = undefined
      if (resolved) {
        image.src = resolved
        if (image.complete && image.naturalWidth > 0) {
          onLoad()
        }
      } else if (key && isLocalImageCacheCapacityBlocked(key)) {
        stopWaitingForCapacity = subscribeToLocalImageCacheCapacity(() => {
          if (key && visible && hasLocalImageCacheCapacity(key)) {
            load()
          }
        })
        if (hasLocalImageCacheCapacity(key)) {
          load()
        }
      } else {
        image.removeAttribute('src')
        clearPlaceholder()
      }
    })
  }

  const onLoad = (): void => {
    if (!visible || !image.hasAttribute('src')) {
      return
    }
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      naturalSize = { width: image.naturalWidth, height: image.naturalHeight }
    }
    clearPlaceholder()
  }
  image.addEventListener('load', onLoad)

  const update = (nextSource: DocumentImageSource): void => {
    const nextKey = nextSource.filePath
      ? getLocalImageSrcCacheKey(
          nextSource.src,
          nextSource.filePath,
          undefined,
          nextSource.runtimeContext,
          nextSource.access
        )
      : null
    const nextIdentity = [
      nextSource.src ?? '',
      nextSource.resolvedSrc ?? '',
      nextSource.filePath,
      nextKey ?? '',
      nextSource.runtimeContext === null ? 'unresolved' : ''
    ].join('\0')
    source = nextSource
    if (identity === nextIdentity) {
      updateLayout()
      return
    }
    image.removeAttribute('src')
    stopRead(true)
    naturalSize = undefined
    renderedSize = undefined
    clearPlaceholder()
    identity = nextIdentity
    key = nextKey
    if (key) {
      placeholder = true
      updateLayout()
      if (!stopObserving) {
        stopObserving = observeViewportVisibility(element, (nextVisible) => {
          if (visible === nextVisible || destroyed) {
            return
          }
          visible = nextVisible
          if (visible) {
            load()
          } else {
            holdLayout()
            image.removeAttribute('src')
            stopRead(true)
          }
        })
      }
      load()
    } else {
      stopObserving?.()
      stopObserving = undefined
      visible = false
      if (
        source.src &&
        source.runtimeContext !== null &&
        (!source.filePath || /^(?:https?|data|blob):/i.test(source.src))
      ) {
        image.src = source.resolvedSrc ?? source.src
      }
    }
  }

  const unsubscribe = onImageCacheInvalidated(() => {
    stopRead(false)
    load()
  })
  update(initialSource)

  return {
    update,
    updateLayout,
    destroy: () => {
      destroyed = true
      image.removeAttribute('src')
      stopRead(true)
      stopObserving?.()
      unsubscribe()
      image.removeEventListener('load', onLoad)
      clearPlaceholder()
    }
  }
}
