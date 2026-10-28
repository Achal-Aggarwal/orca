// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import {
  reconcileRichMarkdownBlockSource,
  registerRichMarkdownBlockSource
} from './rich-markdown-block-source'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'
import { useRichMarkdownProgrammaticSync } from './useRichMarkdownProgrammaticSync'

const editors: Editor[] = []

function open(source: string) {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  registerRichMarkdownBlockSource(editor, codec, false)
  return { editor, codec }
}

function roundTrip(source: string): string {
  const { editor } = open(source)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

function refs(source: string, editor: Editor) {
  return {
    originalSourceRef: { current: source },
    baseCanonicalRef: { current: editor.getMarkdown() },
    lastCommittedMarkdownRef: { current: source }
  }
}

function captureParsedBlocks(editor: Editor, run: () => void) {
  const parsed: WeakRef<ProseMirrorNode>[] = []
  const original = editor.schema.nodeFromJSON
  editor.schema.nodeFromJSON = (json) => {
    const node = original.call(editor.schema, json)
    if (node.type.name === 'doc') {
      node.forEach((child) => parsed.push(new WeakRef(child)))
    }
    return node
  }
  try {
    run()
  } finally {
    editor.schema.nodeFromJSON = original
  }
  return parsed
}

const liveBlocks = (parsed: WeakRef<ProseMirrorNode>[]) =>
  parsed.filter((node) => node.deref() !== undefined).length

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function sourceBlocks(count: number): string {
  const blocks = Array.from(
    { length: count },
    (_, index) => `_Block ${index} ${'x'.repeat(1024)}_`
  ).join('\n\n')
  return `# Heading\n\n${blocks}\n`
}

function cachedSmallDocument() {
  const source = '# Small\n\n_word_\n'
  const task = open(source)
  editors.push(task.editor)
  const state = refs(source, task.editor)
  const parsed = captureParsedBlocks(task.editor, () => {
    expect(
      reconcileRichMarkdownBlockSource(task.editor, source, task.editor.getMarkdown(), roundTrip)
    ).toBe(source)
  })
  return { ...task, refs: state, parsed }
}

function cachedLargeDocument() {
  const source = sourceBlocks(100)
  const task = open(source)
  editors.push(task.editor)
  const state = refs(source, task.editor)
  task.editor.commands.insertContentAt(3, '!')
  const parsed = captureParsedBlocks(task.editor, () => {
    const result = commitRichMarkdownSerialization(task.editor, state, roundTrip)
    expect(result.markdown).toContain('_Block 99')
    expect(roundTrip(result.markdown)).toBe(task.editor.getMarkdown())
  })
  return { ...task, refs: state, parsed }
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

it('releases a previous block baseline after a character-level serialization commit', async () => {
  const task = cachedSmallDocument()
  await collect()
  expect(liveBlocks(task.parsed)).toBe(2)
  task.editor.commands.insertContentAt(3, '!')
  const reparsed = captureParsedBlocks(task.editor, () => {
    const result = commitRichMarkdownSerialization(task.editor, task.refs, roundTrip)
    expect(result.markdown).toContain('_word_')
    expect(roundTrip(result.markdown)).toBe(task.editor.getMarkdown())
  })
  expect(reparsed).toHaveLength(0)
  await collect()
  expect(liveBlocks(task.parsed)).toBe(0)
})

it('releases the old parsed blocks when a replacement exceeds the bounded block diff', async () => {
  const source = sourceBlocks(300)
  const { editor } = open(source)
  editors.push(editor)
  const state = refs(source, editor)
  editor.commands.setContent('tiny', { contentType: 'markdown' })
  const parsed = captureParsedBlocks(editor, () => {
    expect(commitRichMarkdownSerialization(editor, state, roundTrip)).toEqual({
      markdown: 'tiny',
      didSerialize: true
    })
  })
  expect(parsed).toHaveLength(301)
  await collect()
  expect(liveBlocks(parsed)).toBe(0)
  expect(editor.getMarkdown()).toBe('tiny')
})

it.each(['matching document', 'external replacement'])(
  'releases old block baselines on shared-source adoption: %s',
  async (mode) => {
    const task = cachedLargeDocument()
    await collect()
    expect(liveBlocks(task.parsed)).toBe(100)
    const documentBefore = task.editor.state.doc
    const content = mode === 'matching document' ? task.editor.getMarkdown() : 'small _emphasis_'
    const noop = () => {}
    const hook = renderHook(() =>
      useRichMarkdownProgrammaticSync({
        codec: task.codec,
        content,
        editor: task.editor,
        ...task.refs,
        docLinkMenuSetter: noop,
        fileId: 'baseline-retention',
        filePath: '/repo/README.md',
        isApplyingProgrammaticUpdateRef: { current: false },
        onContentChangeRef: { current: noop },
        rootRef: { current: null },
        runtimeTarget: { kind: 'local' },
        serializeTimerRef: { current: null },
        pendingEditEpochRef: { current: 0 },
        slashMenuSetter: noop,
        worktreeId: 'workspace',
        worktreeRoot: null
      })
    )
    try {
      expect(task.refs.originalSourceRef.current).toBe(content)
      expect(task.refs.lastCommittedMarkdownRef.current).toBe(content)
      expect(task.refs.baseCanonicalRef.current).toBe(task.editor.getMarkdown())
      expect(task.editor.state.doc === documentBefore).toBe(mode === 'matching document')
      await collect()
      expect(liveBlocks(task.parsed)).toBe(0)
    } finally {
      hook.unmount()
    }
  }
)

it('keeps the current source reusable across no-op and unsuccessful serialization', async () => {
  const task = cachedSmallDocument()
  const before = structuredClone(task.refs)
  expect(commitRichMarkdownSerialization(null, task.refs, roundTrip).didSerialize).toBe(false)
  const getMarkdown = task.editor.getMarkdown
  task.editor.getMarkdown = () => {
    throw new Error('editor destroyed during serialization')
  }
  try {
    expect(commitRichMarkdownSerialization(task.editor, task.refs, roundTrip).didSerialize).toBe(
      false
    )
  } finally {
    task.editor.getMarkdown = getMarkdown
  }
  expect(task.refs).toEqual(before)
  expect(commitRichMarkdownSerialization(task.editor, task.refs, roundTrip).markdown).toBe(
    before.originalSourceRef.current
  )
  await collect()
  expect(liveBlocks(task.parsed)).toBe(2)
  const parsed = captureParsedBlocks(task.editor, () => {
    expect(
      reconcileRichMarkdownBlockSource(
        task.editor,
        task.refs.originalSourceRef.current,
        task.editor.getMarkdown(),
        roundTrip
      )
    ).toBe(before.originalSourceRef.current)
  })
  // Only validate the result; a missing reusable baseline would also reparse both source blocks.
  expect(parsed).toHaveLength(2)
})
