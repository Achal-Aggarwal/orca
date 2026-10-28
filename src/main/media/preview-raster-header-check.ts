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
