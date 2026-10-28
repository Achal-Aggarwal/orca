// @vitest-environment happy-dom
import { createElement } from 'react'
import { Editor, EditorContent, ReactNodeViewRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import CodeBlock from '@tiptap/extension-code-block'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CodeBlockCopyButton from './CodeBlockCopyButton'
import { RichMarkdownCodeBlock } from './RichMarkdownCodeBlock'
import { positionStableNodeViewUpdate } from './position-stable-node-view-update'

vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en', getResourceBundle: () => null },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({}) }))
vi.mock('./MermaidBlock', () => ({ default: () => null }))

const source = `// copied code\n${'x'.repeat(1024 * 1024)}`
const richExtensions = [
  StarterKit.configure({ codeBlock: false }),
  CodeBlock.extend({
    addNodeView() {
      return ReactNodeViewRenderer(RichMarkdownCodeBlock, { update: positionStableNodeViewUpdate })
    }
  })
]

async function closeRichCopy() {
  const created = Promise.withResolvers<void>()
  const editor = new Editor({
    onCreate: () => created.resolve(),
    extensions: richExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: source }]
        }
      ]
    }
  })
  await created.promise
  const mounted = render(createElement(EditorContent, { editor }))
  await waitFor(() => {
    if (!mounted.container.querySelector('button.code-block-copy-btn')) {
      throw new Error('Code copy control has not mounted')
    }
  })
  const button = mounted.container.querySelector<HTMLButtonElement>('button.code-block-copy-btn')
  if (!button) {
    throw new Error('Missing code copy control')
  }
  const model = editor.state.doc.firstChild
  if (!model) {
    throw new Error('Missing code-block model')
  }
  const refs = {
    editor: new WeakRef(editor),
    document: new WeakRef(editor.state.doc),
    model: new WeakRef(model),
    dom: new WeakRef(editor.view.dom),
    button: new WeakRef(button)
  }
  button.click()
  // React dev retains its last nested-update root; release fixture editor props before root teardown.
  mounted.rerender(createElement('div'))
  mounted.unmount()
  editor.destroy()
  cleanup()
  return refs
}

function closePreviewCopy() {
  const child = createElement('code', null, source)
  const mounted = render(createElement(CodeBlockCopyButton, null, child))
  const button = mounted.container.querySelector<HTMLButtonElement>('button.code-block-copy-btn')
  if (!button) {
    throw new Error('Missing code copy control')
  }
  const code = mounted.container.querySelector('code')
  if (!code) {
    throw new Error('Missing preview code')
  }
  const refs = {
    child: new WeakRef(child),
    props: new WeakRef(child.props),
    dom: new WeakRef(code),
    button: new WeakRef(button)
  }
  button.click()
  mounted.unmount()
  cleanup()
  return refs
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText: vi.fn() } }
  })
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('pending code-copy ownership', () => {
  it('releases closed rich editors while clipboard writes remain pending', async () => {
    const clipboard = Promise.withResolvers<void>()
    vi.mocked(window.api.ui.writeClipboardText).mockReturnValue(clipboard.promise)
    const refs: Awaited<ReturnType<typeof closeRichCopy>>[] = []
    try {
      for (let count = 0; count < 8; count += 1) {
        refs.push(await closeRichCopy())
      }
      await collect()
      expect({
        editors: refs.filter((ref) => ref.editor.deref() !== undefined).length,
        documents: refs.filter((ref) => ref.document.deref() !== undefined).length,
        models: refs.filter((ref) => ref.model.deref() !== undefined).length,
        doms: refs.filter((ref) => ref.dom.deref() !== undefined).length,
        buttons: refs.filter((ref) => ref.button.deref() !== undefined).length
      }).toEqual({ editors: 0, documents: 0, models: 0, doms: 0, buttons: 0 })
      expect(window.api.ui.writeClipboardText).toHaveBeenCalledTimes(8)
      expect(window.api.ui.writeClipboardText).toHaveBeenCalledWith(source)
    } finally {
      clipboard.resolve()
      await Promise.resolve()
    }
  })

  it('releases preview code children while clipboard writes remain pending', async () => {
    const clipboard = Promise.withResolvers<void>()
    vi.mocked(window.api.ui.writeClipboardText).mockReturnValue(clipboard.promise)
    const refs = Array.from({ length: 8 }, closePreviewCopy)
    try {
      await collect()
      expect({
        children: refs.filter((ref) => ref.child.deref() !== undefined).length,
        props: refs.filter((ref) => ref.props.deref() !== undefined).length,
        doms: refs.filter((ref) => ref.dom.deref() !== undefined).length,
        buttons: refs.filter((ref) => ref.button.deref() !== undefined).length
      }).toEqual({ children: 0, props: 0, doms: 0, buttons: 0 })
      expect(window.api.ui.writeClipboardText).toHaveBeenCalledTimes(8)
      expect(window.api.ui.writeClipboardText).toHaveBeenCalledWith(source)
    } finally {
      clipboard.resolve()
      await Promise.resolve()
    }
  })
})
