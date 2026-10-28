import type { LocalFileAccess } from '../../../../shared/local-file-access'
import type { RichMarkdownImageRuntimeContext } from './rich-markdown-image-context'

export type DocumentImageSource = {
  src: string | undefined
  filePath: string
  runtimeContext?: RichMarkdownImageRuntimeContext | null
  access?: LocalFileAccess
  resolvedSrc?: string
}

const sources = new WeakMap<HTMLImageElement, DocumentImageSource>()

function copyAccess(access: LocalFileAccess | undefined): LocalFileAccess | undefined {
  if (!access) {
    return undefined
  }
  return Object.freeze(
    access.kind === 'document-resource' || access.kind === 'document-folder'
      ? { kind: access.kind, documentPath: access.documentPath }
      : { kind: access.kind }
  )
}

export function setDocumentImageSource(image: HTMLImageElement, source: DocumentImageSource): void {
  const context = source.runtimeContext
  sources.set(
    image,
    Object.freeze({
      src: source.src,
      filePath: source.filePath,
      resolvedSrc: source.resolvedSrc,
      access: copyAccess(source.access),
      runtimeContext: context
        ? Object.freeze({
            target: Object.freeze(
              context.target.kind === 'environment'
                ? { kind: context.target.kind, environmentId: context.target.environmentId }
                : { kind: context.target.kind }
            ),
            worktreeId: context.worktreeId,
            worktreePath: context.worktreePath,
            connectionId: context.connectionId,
            expectedExecutionHostId: context.expectedExecutionHostId,
            expectedSshTargetId: context.expectedSshTargetId,
            expectedSshConnectionGeneration: context.expectedSshConnectionGeneration,
            expectedExternalSshTargetId: context.expectedExternalSshTargetId
          })
        : context
    })
  )
}

export function getDocumentImageSource(image: HTMLImageElement): DocumentImageSource | undefined {
  return sources.get(image)
}

export function deleteDocumentImageSource(image: HTMLImageElement): void {
  sources.delete(image)
}
