// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { buildOwnedEditorFileId } from '@/store/slices/editor/file-ids/editor-file-ids'
import type { FileContent } from './editor-panel-content-types'

vi.mock('@/lib/lazy-with-retry', () => ({
  lazyWithRetry: (factory: () => Promise<unknown>) => {
    if (factory.toString().includes('ImageViewer') || factory.toString().includes('MediaViewer')) {
      return function BinaryViewer({
        scrollCacheKey,
        playbackCacheKey
      }: {
        scrollCacheKey?: string
        playbackCacheKey?: string
      }) {
        return <output data-position-key={scrollCacheKey ?? playbackCacheKey} />
      }
    }
    return () => null
  }
}))

import { EditorContent } from './EditorContent'

function sourceFile(filePath: string): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: filePath.slice(filePath.lastIndexOf('/') + 1),
    worktreeId: 'wt-local',
    language: 'plaintext',
    mode: 'edit',
    isDirty: false,
    runtimeEnvironmentId: null
  }
}
const contents: { name: string; filePath: string; fileContent: FileContent }[] = [
  {
    name: 'PDF',
    filePath: '/repo/report.pdf',
    fileContent: { content: 'JVBERi0=', isBinary: true, isImage: true, mimeType: 'application/pdf' }
  },
  {
    name: 'media',
    filePath: '/repo/video.mp4',
    fileContent: {
      content: '',
      isBinary: true,
      mediaUrl: 'orca-media://fixture/video',
      mimeType: 'video/mp4'
    }
  }
]

function positionKey(
  file: OpenFile,
  fileContent: FileContent,
  scope = file.id
): string | undefined {
  const html = renderToStaticMarkup(
    <EditorContent
      activeFile={file}
      viewStateScopeId={scope}
      fileContents={{ [file.id]: fileContent }}
      diffContents={{}}
      editBuffers={{}}
      openFiles={[file]}
      worktreeEntries={[]}
      resolvedLanguage="plaintext"
      isMarkdown={false}
      isMermaid={false}
      isCsv={false}
      isNotebook={false}
      mdViewMode="rich"
      inlineMarkdownRenderState={null}
      isChangesMode={false}
      sideBySide={false}
      pendingEditorReveal={null}
      handleContentChange={vi.fn()}
      handleContentChangeForFile={vi.fn()}
      handleDirtyStateHint={vi.fn()}
      handleSave={async () => true}
      handleSaveForFile={async () => true}
      reloadContent={vi.fn()}
    />
  )
  const container = document.createElement('div')
  container.innerHTML = html
  return container.querySelector('output')?.dataset.positionKey
}

describe.each(contents)('$name position ownership', ({ filePath, fileContent }) => {
  const localFile = sourceFile(filePath)
  it.each([
    { worktreeId: 'wt-other', runtimeEnvironmentId: null },
    { worktreeId: 'wt-local', runtimeEnvironmentId: 'host-other' },
    { worktreeId: 'folder:other', runtimeEnvironmentId: null }
  ])(
    'keeps $worktreeId / $runtimeEnvironmentId separate from the same-path local owner',
    (owner) => {
      const other = {
        ...localFile,
        ...owner,
        id: buildOwnedEditorFileId(filePath, owner.worktreeId, owner.runtimeEnvironmentId)
      }
      expect(positionKey(localFile, fileContent)).toBeTruthy()
      expect(positionKey(other, fileContent)).toBeTruthy()
      expect(positionKey(other, fileContent)).not.toBe(positionKey(localFile, fileContent))
    }
  )

  it('keeps a later owner separate when a legacy raw path ID is reused', () => {
    const laterOwner = { ...localFile, worktreeId: 'wt-later' }
    expect(positionKey(laterOwner, fileContent)).not.toBe(positionKey(localFile, fileContent))
  })

  it('keeps explicit split-pane positions separate', () => {
    const left = positionKey(localFile, fileContent, 'left-pane')
    const right = positionKey(localFile, fileContent, 'right-pane')
    expect(left).toBe(`${filePath}::left-pane:pdf`)
    expect(right).toBe(`${filePath}::right-pane:pdf`)
    expect(left).not.toBe(right)
  })
})
