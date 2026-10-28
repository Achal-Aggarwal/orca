import { RpcString, RpcUnknown } from './rpc-value-schemas'
import { WorktreeSelector } from './files-target-params'

export const TerminalArtifactFile = WorktreeSelector.extend({
  grantId: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing terminal artifact grant')
  ),
  absolutePath: RpcUnknown.transform((v) => (typeof v === 'string' ? v : '')).pipe(
    RpcString.min(1, 'Missing terminal artifact path')
  )
})

export const TerminalArtifactFileWrite = TerminalArtifactFile.extend({
  content: RpcUnknown.refine((v): v is string => typeof v === 'string', {
    message: 'Missing file content'
  })
})
