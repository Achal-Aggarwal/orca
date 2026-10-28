import type { FileHandle } from 'node:fs/promises'
import type { FilePreview } from '../../shared/file-preview-kind'
import { rasterImageExceedsPreviewLimits } from '../../shared/raster-image-prefix-limits'
import { RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR } from '../../shared/raster-image-preview-limits'

/** A URL preview keeps the base64 path's guard: an image whose header proves it oversized never reaches the decoder. */
export async function assertPreviewableRasterHeader(
  preview: FilePreview,
  readPrefix: (bytes: number) => Promise<Uint8Array>
): Promise<void> {
  if (preview.kind !== 'image') {
    return
  }
  if (await rasterImageExceedsPreviewLimits(readPrefix, preview.mimeType)) {
    throw new Error(RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR)
  }
}

/** A local file's first bytes for the check, read from the handle that serves it. */
export function localPrefixReader(handle: FileHandle, size: number) {
  return async (bytes: number): Promise<Uint8Array> => {
    const buffer = Buffer.alloc(Math.min(bytes, size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  }
}
