// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-import-client'
import { useLocalImagePick } from './useLocalImagePick'
import { handleRichMarkdownImagePaste } from './rich-markdown-paste-image'

vi.mock('@/runtime/runtime-file-import-client', () => ({ importExternalPathsToRuntime: vi.fn() }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: null,
      folderWorkspaces: [],
      worktreesByRepo: {},
      openFiles: []
    })
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

type ImportResult = Awaited<ReturnType<typeof importExternalPathsToRuntime>>
const imported: ImportResult = {
  results: [
    {
      sourcePath: '/tmp/image.png',
      status: 'imported',
      destPath: '/repo/image.png',
      kind: 'file',
      renamed: false
    }
  ]
}

type RequestKind = 'pick' | 'paste'
type RequestStage = 'source' | 'import'

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

async function closeWithPendingImage(kind: RequestKind) {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit, Image.configure({ inline: true })],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `hello ${'x'.repeat(1024 * 1024)}` }]
        }
      ]
    }
  })
  const refs = {
    editor: new WeakRef(editor),
    document: new WeakRef(editor.state.doc),
    dom: new WeakRef(editor.view.dom)
  }
  if (kind === 'pick') {
    const hook = renderHook(() => useLocalImagePick(editor, '/repo/note.md', null))
    void hook.result.current()
    await Promise.resolve()
    hook.unmount()
    cleanup()
  } else {
    const data = new DataTransfer()
    data.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
    const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
    expect(
      handleRichMarkdownImagePaste({
        editor,
        event,
        filePath: '/repo/note.md',
        worktreeId: null
      })
    ).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    for (let round = 0; round < 4; round += 1) {
      await Promise.resolve()
    }
  }
  editor.destroy()
  element.remove()
  return refs
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      shell: { pickImage: vi.fn().mockResolvedValue('/tmp/image.png') },
      ui: { saveClipboardImageAsTempFile: vi.fn().mockResolvedValue('/tmp/image.png') }
    }
  })
  vi.mocked(importExternalPathsToRuntime).mockResolvedValue(imported)
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('pending rich Markdown image ownership', () => {
  it.each([
    ['pick', 'source'],
    ['paste', 'source'],
    ['pick', 'import'],
    ['paste', 'import']
  ] as const)(
    'releases closed editors during %s %s requests',
    async (kind: RequestKind, stage: RequestStage) => {
      const source = Promise.withResolvers<string | null>()
      const importing = Promise.withResolvers<ImportResult>()
      if (stage === 'source') {
        vi.mocked(
          kind === 'pick' ? window.api.shell.pickImage : window.api.ui.saveClipboardImageAsTempFile
        ).mockReturnValue(source.promise)
      } else {
        vi.mocked(importExternalPathsToRuntime).mockReturnValue(importing.promise)
      }
      const refs: Awaited<ReturnType<typeof closeWithPendingImage>>[] = []
      try {
        for (let count = 0; count < 8; count += 1) {
          refs.push(await closeWithPendingImage(kind))
        }
        await collect()
        expect({
          editors: refs.filter((ref) => ref.editor.deref() !== undefined).length,
          documents: refs.filter((ref) => ref.document.deref() !== undefined).length,
          doms: refs.filter((ref) => ref.dom.deref() !== undefined).length
        }).toEqual({ editors: 0, documents: 0, doms: 0 })
        if (stage === 'source') {
          expect(importExternalPathsToRuntime).not.toHaveBeenCalled()
        } else {
          expect(importExternalPathsToRuntime).toHaveBeenCalledTimes(8)
        }
      } finally {
        source.resolve('/tmp/image.png')
        importing.resolve(imported)
        await Promise.resolve()
      }
    }
  )
})
