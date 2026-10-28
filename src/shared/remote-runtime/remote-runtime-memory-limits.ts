import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../node-bounded-json-stringify'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import type { RuntimeOrchestrationEnvelope } from '../runtime-rpc-envelope'

export const REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES = 4 * 1024 * 1024
// Why: a host refuses a larger client frame by closing the socket (1009), failing every call on it.
export const REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES = 1024 * 1024
// Why: a sealed frame is base64 of nonce, MAC and (v2) a 42-byte header around the request JSON.
const REMOTE_RUNTIME_MAX_SEALING_OVERHEAD_BYTES = 128
/** The largest request JSON that still fits a host's inbound frame once sealed. */
export const REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES =
  Math.floor(REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES / 4) * 3 -
  REMOTE_RUNTIME_MAX_SEALING_OVERHEAD_BYTES
// Why: sealing inflates a request by up to 4/3, so this much JSON-escaped content still fits a frame.
export const REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES = 720 * 1024
export const REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES = 8 * 1024 * 1024 + 64
export const REMOTE_RUNTIME_MAX_SUBSCRIPTIONS = 256
export const REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES = 1024 * 1024
export const REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES = 16 * 1024 * 1024
export const REMOTE_RUNTIME_MAX_PENDING_REQUESTS = 256
export const REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES = 32 * 1024 * 1024
export const REMOTE_RUNTIME_MAX_PREPARED_RPC_BYTES = REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES
export const REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS = REMOTE_RUNTIME_MAX_PENDING_REQUESTS * 2
export const REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES = REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES * 2
export const REMOTE_RUNTIME_MAX_READY_WAITERS =
  REMOTE_RUNTIME_MAX_PENDING_REQUESTS + REMOTE_RUNTIME_MAX_SUBSCRIPTIONS
export const REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES = 8 * 1024 * 1024

export function serializeRemoteRuntimePayload(value: unknown): string {
  return serializeRemoteRuntimePayloadWithBytes(value).serialized
}

function serializeRemoteRuntimePayloadWithBytes(value: unknown): {
  serialized: string
  byteLength: number
} {
  try {
    return stringifyJsonWithinByteLimit(value, REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES)
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw remoteRuntimePayloadLimitError()
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new RemoteRuntimeClientError(
      'invalid_argument',
      `Remote runtime JSON payload could not be serialized: ${message}`
    )
  }
}

function remoteRuntimePayloadLimitError(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'invalid_argument',
    `Remote runtime JSON payload exceeds ${REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES} bytes.`
  )
}

export class PreparedRemoteRuntimeCallPayload {
  readonly retainedBytes: number
  private readonly serialized: string
  private readonly byteLength: number

  constructor(params: unknown, envelope?: RuntimeOrchestrationEnvelope) {
    const payload = serializeRemoteRuntimePayloadWithBytes({
      params,
      orchestrationCapability: envelope?.orchestrationCapability,
      orchestrationContractVersion: envelope?.orchestrationContractVersion,
      orchestrationRequestId: envelope?.orchestrationRequestId,
      compatibilityInvocationId: envelope?.compatibilityInvocationId,
      orchestrationCompatibilityEvidence: envelope?.orchestrationCompatibilityEvidence
    })
    this.serialized = payload.serialized
    this.byteLength = payload.byteLength
    this.retainedBytes = retainedRemoteRuntimeJsonStringBytes(this.serialized)
  }

  readParams(): unknown {
    const payload: unknown = JSON.parse(this.serialized)
    return typeof payload === 'object' && payload !== null && 'params' in payload
      ? payload.params
      : undefined
  }

  serializeRequest(header: Record<string, unknown>): string {
    const preparedHeader = serializeRemoteRuntimePayloadWithBytes(header)
    if (preparedHeader.serialized === '{}') {
      return this.serialized
    }
    if (this.serialized === '{}') {
      return preparedHeader.serialized
    }
    if (preparedHeader.byteLength + this.byteLength - 1 > REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES) {
      throw remoteRuntimePayloadLimitError()
    }
    return `${preparedHeader.serialized.slice(0, -1)},${this.serialized.slice(1)}`
  }

  toJSON(): never {
    throw new Error('Prepared runtime calls must use the request serializer.')
  }
}

export function serializePreparedRemoteRuntimeRequest(message: unknown): string | undefined {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('params' in message) ||
    !(message.params instanceof PreparedRemoteRuntimeCallPayload)
  ) {
    return undefined
  }
  const header = Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'params'))
  return message.params.serializeRequest(header)
}

export function measureRemoteRuntimeSubscriptionParams(params: unknown): number {
  if (params === undefined) {
    return 0
  }
  try {
    return stringifyJsonWithinByteLimit(params, REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES)
      .byteLength
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new RemoteRuntimeClientError(
        'invalid_argument',
        `Remote runtime subscription parameters exceed ${REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES} bytes.`
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new RemoteRuntimeClientError(
      'invalid_argument',
      `Remote runtime subscription parameters could not be serialized: ${message}`
    )
  }
}

export function serializeRemoteRuntimeRpcRequest(args: {
  requestId: string
  deviceToken: string
  method: string
  params: unknown
  envelope?: RuntimeOrchestrationEnvelope
}): string {
  if (args.params instanceof PreparedRemoteRuntimeCallPayload) {
    return args.params.serializeRequest({
      id: args.requestId,
      deviceToken: args.deviceToken,
      method: args.method
    })
  }
  return serializeRemoteRuntimePayload({
    id: args.requestId,
    deviceToken: args.deviceToken,
    method: args.method,
    params: args.params,
    orchestrationCapability: args.envelope?.orchestrationCapability,
    orchestrationContractVersion: args.envelope?.orchestrationContractVersion,
    orchestrationRequestId: args.envelope?.orchestrationRequestId,
    compatibilityInvocationId: args.envelope?.compatibilityInvocationId,
    orchestrationCompatibilityEvidence: args.envelope?.orchestrationCompatibilityEvidence
  })
}

export function retainedRemoteRuntimeJsonStringBytes(value: string): number {
  return value.length * 3
}

export function isRemoteRuntimeBinaryFrameWithinLimit(bytes: Uint8Array<ArrayBufferLike>): boolean {
  return bytes.byteLength <= REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES
}
