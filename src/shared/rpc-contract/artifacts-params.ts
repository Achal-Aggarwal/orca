import { RpcString } from './rpc-value-schemas'
import { z } from 'zod'
import {
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_MAX_REQUEST_BYTES,
  artifactContentByteLength,
  artifactWriteRequestByteLength
} from '../artifacts'

export const CloudOptions = {
  apiUrl: RpcString.max(2_048).optional(),
  authToken: RpcString.max(16_384).optional()
}

export const ListOptions = z.object({
  ...CloudOptions,
  cursor: RpcString.min(1).max(2_048).optional()
})

export const SourceRequest = z.object({
  sourceKey: RpcString.min(1).max(32_768),
  ...CloudOptions
})

export const WriteRequest = z
  .object({
    sourceKey: RpcString.min(1).max(32_768),
    content: RpcString.min(1)
      .max(ARTIFACT_MAX_CONTENT_BYTES)
      .refine((content) => artifactContentByteLength(content) <= ARTIFACT_MAX_CONTENT_BYTES, {
        message: 'Artifact content exceeds the 10 MiB limit.'
      }),
    contentType: z.enum(['text/html', 'text/markdown']),
    fileName: RpcString.min(1).max(512),
    title: RpcString.max(512).optional(),
    ...CloudOptions
  })
  .refine((request) => artifactWriteRequestByteLength(request) <= ARTIFACT_MAX_REQUEST_BYTES, {
    message: 'Artifact request exceeds the supported size.'
  })

export const ArtifactsDeleteParams = z.object({ id: RpcString.min(1), ...CloudOptions })
