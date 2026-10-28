import { forEachWithConcurrency } from '../../../../shared/map-with-concurrency'
import { getDocumentImageSource, type DocumentImageSource } from './document-image-sources'
import { getLocalImageCacheKey } from './useLocalImageSrc'
import { resolveImageAbsolutePath } from './markdown-preview-links'
import { getLocalImageReadOwnerKey, runLocalImageRead } from './local-image-read-admission'
import { readLocalImagePreview } from './local-image-src-reader'

type MarkdownExportLocalImage = {
  absolutePath: string
  source: DocumentImageSource
  images: HTMLImageElement[]
}

export function captureMarkdownExportLocalImages(
  subtree: Element,
  clone: Element,
  excludedSelector: string
): MarkdownExportLocalImage[] {
  const originals = subtree.querySelectorAll('img')
  const images = clone.querySelectorAll('img')
  const localImages = new Map<string, MarkdownExportLocalImage>()
  for (let index = 0; index < originals.length; index += 1) {
    const original = originals[index]
    const image = images[index]
    if (!original || !image || image.closest(excludedSelector)) {
      continue
    }
    const source = getDocumentImageSource(original)
    const absolutePath = source?.filePath
      ? resolveImageAbsolutePath(source.src, source.filePath)
      : null
    if (!source || !absolutePath) {
      continue
    }
    const key =
      (source.runtimeContext === null ? 'unresolved\0' : '') +
      getLocalImageCacheKey(
        absolutePath,
        undefined,
        source.runtimeContext ?? undefined,
        source.access
      )
    let localImage = localImages.get(key)
    if (!localImage) {
      localImage = { absolutePath, source, images: [] }
      localImages.set(key, localImage)
    }
    localImage.images.push(image)
    image.removeAttribute('src')
    image.parentElement?.classList.remove('document-image-placeholder')
  }
  return [...localImages.values()]
}

export async function inlineMarkdownExportLocalImages(
  localImages: MarkdownExportLocalImage[],
  controller: AbortController
): Promise<void> {
  const { signal } = controller
  const clearImages = (): void => {
    for (const localImage of localImages) {
      localImage.images.length = 0
    }
  }
  signal.addEventListener('abort', clearImages, { once: true })
  try {
    await forEachWithConcurrency(localImages, 4, async (localImage) => {
      if (signal.aborted) {
        throw signal.reason
      }
      const dataUrl = await readMarkdownExportLocalImage(
        localImage.absolutePath,
        localImage.source,
        controller
      )
      if (signal.aborted) {
        throw signal.reason
      }
      for (const image of localImage.images) {
        image.setAttribute('src', dataUrl)
      }
    })
  } finally {
    signal.removeEventListener('abort', clearImages)
  }
}

async function readMarkdownExportLocalImage(
  absolutePath: string,
  source: DocumentImageSource,
  controller: AbortController
): Promise<string> {
  const { signal } = controller
  const context = source.runtimeContext
  if (context === null) {
    const error = new Error('Cannot export an image before its document owner is resolved')
    controller.abort(error)
    throw error
  }
  const ownerKey = getLocalImageReadOwnerKey(undefined, context)
  return runLocalImageRead(ownerKey, signal, async () => {
    try {
      const result = await readLocalImagePreview(absolutePath, undefined, context, source.access)
      if (signal.aborted) {
        throw signal.reason
      }
      if (!result.isBinary || !result.content) {
        throw new Error(`Failed to read image for PDF export: ${source.src ?? absolutePath}`)
      }
      return `data:${result.mimeType ?? 'image/png'};base64,${result.content.replace(/\s/g, '')}`
    } catch (error) {
      controller.abort(error)
      throw error
    }
  })
}
