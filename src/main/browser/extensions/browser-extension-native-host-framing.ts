import { endianness } from 'node:os'
import { RelayFrameBuffer } from '../../../shared/relay-frame-buffer'

/**
 * Chrome's native messaging wire format: each message is a 32-bit length in the machine's native
 * byte order followed by that many bytes of UTF-8 JSON.
 */

const HEADER_BYTES = 4
const MAX_PENDING_FRAME_CHUNKS = 1024
/** Chrome refuses host → extension messages over 1 MB (kMaximumNativeMessageSize). */
export const MAX_NATIVE_HOST_MESSAGE_BYTES = 1024 * 1024

const littleEndian = endianness() === 'LE'

export function encodeNativeHostMessage(json: string): Buffer {
  const body = Buffer.from(json, 'utf8')
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length)
  if (littleEndian) {
    frame.writeUInt32LE(body.length, 0)
  } else {
    frame.writeUInt32BE(body.length, 0)
  }
  body.copy(frame, HEADER_BYTES)
  return frame
}

export type NativeHostMessageReader = {
  /** Feeds one stdout chunk; returns false once the stream is unusable (the reader stops). */
  push: (chunk: Buffer) => boolean
}

/**
 * Reassembles messages across stdout chunks. `onMessage` gets the JSON text, already checked to
 * parse; an oversized or malformed message calls `onError` once and stops the reader.
 */
export function createNativeHostMessageReader(
  onMessage: (json: string) => void,
  onError: (reason: string) => void
): NativeHostMessageReader {
  const pending = new RelayFrameBuffer()
  let failed = false

  const fail = (reason: string): false => {
    failed = true
    pending.clear()
    onError(reason)
    return false
  }

  const readSize = (): number => {
    const head = pending.peek(HEADER_BYTES)
    return littleEndian ? head.readUInt32LE(0) : head.readUInt32BE(0)
  }

  return {
    push: (chunk) => {
      if (failed) {
        return false
      }
      if (chunk.length === 0) {
        return true
      }
      if (pending.chunkCount >= MAX_PENDING_FRAME_CHUNKS) {
        const buffered = pending.drain()
        pending.append(buffered)
      }
      pending.append(chunk)
      while (pending.length >= HEADER_BYTES) {
        const size = readSize()
        if (size > MAX_NATIVE_HOST_MESSAGE_BYTES) {
          return fail(`message of ${size} bytes is over the 1 MB limit`)
        }
        if (pending.length < HEADER_BYTES + size) {
          break
        }
        const buffered = pending.take(HEADER_BYTES + size)
        const json = buffered.toString('utf8', HEADER_BYTES, HEADER_BYTES + size)
        try {
          JSON.parse(json)
        } catch {
          return fail('message is not valid JSON')
        }
        onMessage(json)
      }
      pending.releaseConsumedBacking()
      return true
    }
  }
}
