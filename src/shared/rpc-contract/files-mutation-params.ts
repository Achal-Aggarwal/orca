import { RpcNumber, RpcOptionalBoolean, RpcString, RpcUnknown } from './rpc-value-schemas'
import { z } from 'zod'
import { FileOpen, WorktreeSelector } from './files-target-params'

export const RUNTIME_FILE_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export function isValidRuntimeFileBase64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length % 4 !== 1 &&
    (!value.includes('=') || value.length % 4 === 0) &&
    RUNTIME_FILE_BASE64_PATTERN.test(value)
  )
}

export const FileMutationOpen = FileOpen.extend({
  expectedExecutionHostId: RpcString.min(1).optional(),
  expectedSshTargetId: RpcString.min(1).optional(),
  expectedSshConnectionGeneration: RpcNumber.int().nonnegative().optional()
})

// Reject missing/non-string content instead of coercing to empty and truncating the file; explicit empty remains valid.
export const FileWrite = FileMutationOpen.extend({
  content: RpcUnknown.refine((v): v is string => typeof v === 'string', {
    message: 'Missing file content'
  })
})

// Why a separate method: a host too old to honor the precondition answers method_not_found
// instead of silently dropping the field and writing over newer disk content.
export const FileWriteIfUnchanged = FileWrite.extend({
  diskPrecondition: z.object({
    expectedSignature: RpcString.min(1).max(64),
    allowMissing: RpcOptionalBoolean,
    requireLosslessUtf8: RpcOptionalBoolean
  })
})

export const FileWriteBase64 = FileMutationOpen.extend({
  contentBase64: RpcUnknown.refine((v): v is string => typeof v === 'string', {
    message: 'Missing file content'
  })
    // Buffer.from tolerates malformed base64 and may silently create empty or corrupt files.
    .refine(isValidRuntimeFileBase64, 'File content must be base64')
})

export const FileWriteBase64Chunk = FileWriteBase64.extend({
  append: RpcOptionalBoolean
})

export const FileRename = WorktreeSelector.extend({
  expectedExecutionHostId: RpcString.min(1).optional(),
  expectedSshTargetId: RpcString.min(1).optional(),
  expectedSshConnectionGeneration: RpcNumber.int().nonnegative().optional(),
  oldRelativePath: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing source path')
  ),
  newRelativePath: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing destination path')
  )
})

export const FileCopy = WorktreeSelector.extend({
  expectedExecutionHostId: RpcString.min(1).optional(),
  expectedSshTargetId: RpcString.min(1).optional(),
  expectedSshConnectionGeneration: RpcNumber.int().nonnegative().optional(),
  sourceRelativePath: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing source path')
  ),
  destinationRelativePath: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing destination path')
  )
})

export const FileCommitUpload = WorktreeSelector.extend({
  expectedExecutionHostId: RpcString.min(1).optional(),
  expectedSshTargetId: RpcString.min(1).optional(),
  expectedSshConnectionGeneration: RpcNumber.int().nonnegative().optional(),
  tempRelativePath: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing temporary path')
  ),
  finalRelativePath: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing final path')
  )
})

export const FileDelete = FileMutationOpen.extend({
  recursive: RpcOptionalBoolean
})
