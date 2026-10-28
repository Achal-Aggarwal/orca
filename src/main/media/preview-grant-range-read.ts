import { resolveLocalFileRequestPath } from '../ipc/local-file-access-resolution'
import { openLocalRegularFile } from '../ipc/filesystem/local-regular-file-read'
import { previewGrantForSender, remoteSnapshot, revokeGrant } from './preview-grant-registry'
import {
  RemotePreviewPairingChangedError,
  readRemotePreviewRange
} from './remote-file-preview-reader'

/** pdf.js asks in 256 KiB chunks but may merge neighbours; the renderer splits anything larger. */
export const PREVIEW_RANGE_READ_MAX_BYTES = 4 * 1024 * 1024

/**
 * A PDF grant's bytes for the renderer that minted it. pdf.js reads ranges here instead of over
 * fetch, so orca-media needs no fetch or CORS privileges and no other page or frame can read them.
 */
export async function readPreviewGrantRange(
  senderId: number,
  url: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > PREVIEW_RANGE_READ_MAX_BYTES
  ) {
    throw new Error('Invalid preview range')
  }
  const found = previewGrantForSender(url, senderId)
  if (!found || found.grant.preview.kind !== 'pdf') {
    throw new Error('Preview is no longer available')
  }
  const { token, grant } = found
  if ('remote' in grant.target) {
    const remote = grant.target.remote
    try {
      const { size } = await remoteSnapshot(grant, remote)
      return await readRemotePreviewRange(
        remote,
        offset,
        length,
        size,
        new AbortController().signal
      )
    } catch (error) {
      if (error instanceof RemotePreviewPairingChangedError) {
        revokeGrant(token)
      }
      throw error
    }
  }
  if (grant.target.connectionId) {
    throw new Error('Preview is no longer available')
  }
  const filePath = await resolveLocalFileRequestPath(
    grant.target.filePath,
    grant.target.access,
    grant.store
  )
  const { handle, stats } = await openLocalRegularFile(filePath)
  try {
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, stats.size - offset)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
  } finally {
    await handle.close()
  }
}
