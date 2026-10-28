// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import type * as ReactDomClientModule from 'react-dom/client'
import type * as DiffCommentZoneCardModule from './diff-comment-zone-card'
import type { NotesSendMenu } from '../editor/NotesSendMenu'
import type * as NotesSendMenuModule from '../editor/NotesSendMenu'

vi.mock('monaco-editor', () => import('monaco-editor/esm/vs/editor/editor.api.js'))

const notesMenuFixture = vi.hoisted(() => ({
  NotesSendMenu: vi.fn<typeof NotesSendMenu>(() => {
    throw new Error('Commentable-line lifecycle must not render the agent notes menu')
  })
}))

vi.mock('../editor/NotesSendMenu', async (importOriginal) => ({
  ...(await importOriginal<typeof NotesSendMenuModule>()),
  NotesSendMenu: notesMenuFixture.NotesSendMenu
}))

const storeFixture = vi.hoisted(
  (): {
    activeGroupIdByWorktree: Record<string, string>
    agentSendPopoverTargetMode: { id: string } | null
    clearDeliveredDiffComments: ReturnType<typeof vi.fn>
  } => ({
    activeGroupIdByWorktree: {},
    agentSendPopoverTargetMode: null,
    clearDeliveredDiffComments: vi.fn()
  })
)

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeFixture) => unknown) => selector(storeFixture)
}))

// Stub card rendering to isolate zone/root lifecycles.
vi.mock('./diff-comment-zone-card', async (importOriginal) => ({
  ...(await importOriginal<typeof DiffCommentZoneCardModule>()),
  renderDiffCommentZoneCard: vi.fn()
}))

const rootCounts = vi.hoisted(() => ({ created: 0, unmounted: 0 }))

// Count only roots the decorator creates for its zones — @testing-library/react creates its own.
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactDomClientModule>()
  return {
    ...actual,
    createRoot: (container: Element, options?: Parameters<typeof actual.createRoot>[1]) => {
      const isZoneRoot = container.classList?.contains('orca-diff-comment-inline') ?? false
      if (isZoneRoot) {
        rootCounts.created += 1
      }
      const root = actual.createRoot(container, options)
      return {
        render: (node: Parameters<typeof root.render>[0]) => root.render(node),
        unmount: () => {
          if (isZoneRoot) {
            rootCounts.unmounted += 1
          }
          root.unmount()
        }
      }
    }
  }
})

import { useDiffCommentDecorator } from './useDiffCommentDecorator'
import { renderDiffCommentZoneCard } from './diff-comment-zone-card'
import { formatMarkdownReviewNotes } from '@/lib/markdown-review-notes'
import { buildNotesSendTargetModeId } from '../editor/NotesSendMenu'
import {
  createFakeDiffCommentEditor,
  type FakeDiffCommentEditor
} from './diff-comment-editor-test-fixture'

const FILE_PATH = 'src/index.ts'
const REVIEW_SURFACE_ID = 'pr:acme/widgets:42'

function reviewNote(index: number): DecoratedDiffComment {
  return {
    id: `review-note-${index}`,
    worktreeId: REVIEW_SURFACE_ID,
    filePath: FILE_PATH,
    lineNumber: 10 + index,
    body: `Please rename this (${index}).`,
    createdAt: index,
    side: 'modified',
    author: 'octocat'
  }
}

// Remote review refreshes replace arrays even when their values match.
function freshCommentableLines(): readonly number[] {
  return [10, 11, 12, 13, 14, 15, 16]
}

// Drain deferred root unmounts before reading counts.
async function flushDeferredUnmounts(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function lifecycleTotals(fake: FakeDiffCommentEditor): Record<string, number> {
  return {
    createRootCalls: rootCounts.created,
    rootUnmounts: rootCounts.unmounted,
    monacoViewZones: fake.zones.size
  }
}

function isAddButtonVisible(domNode: HTMLElement): boolean {
  const button = domNode.querySelector<HTMLElement>('.orca-diff-comment-add-btn')
  return button != null && button.style.display !== 'none'
}

type DecoratorProps = {
  commentableLineNumbers: readonly number[]
  comments: readonly DecoratedDiffComment[]
}

function renderDecorator(fake: FakeDiffCommentEditor, initialProps: DecoratorProps) {
  return renderHook(
    ({ commentableLineNumbers, comments }: DecoratorProps) =>
      useDiffCommentDecorator({
        editor: fake.editor,
        filePath: FILE_PATH,
        worktreeId: REVIEW_SURFACE_ID,
        comments,
        commentableLineNumbers,
        onAddCommentClick: vi.fn(),
        onDeleteComment: vi.fn()
      }),
    { initialProps }
  )
}

beforeEach(() => {
  rootCounts.created = 0
  rootCounts.unmounted = 0
  storeFixture.agentSendPopoverTargetMode = null
})

afterEach(async () => {
  cleanup()
  await flushDeferredUnmounts()
  document.body.replaceChildren()
  try {
    expect(notesMenuFixture.NotesSendMenu).not.toHaveBeenCalled()
  } finally {
    vi.clearAllMocks()
  }
})

function countingCommentableLines(length: number): {
  lines: readonly number[]
  joins: () => number
} {
  const lines = Array.from({ length }, (_, index) => index + 1)
  let joins = 0
  Object.defineProperty(lines, 'join', {
    configurable: true,
    value: (separator?: string) => {
      joins += 1
      return Array.prototype.join.call(lines, separator)
    }
  })
  return { lines, joins: () => joins }
}

describe('useDiffCommentDecorator commentable-line churn', () => {
  it('does not format send prompts or rerender note cards while editing the document', () => {
    const fake = createFakeDiffCommentEditor({ lineCount: 20_000 })
    const comments = Array.from({ length: 20 }, (_, index) => ({
      ...reviewNote(index),
      source: 'markdown' as const,
      lineNumber: 19_000 + index
    }))
    const formatPrompt = vi.fn((content: string, comment: DecoratedDiffComment) =>
      formatMarkdownReviewNotes([{ ...comment, source: 'markdown' }], content)
    )
    const content = 'A line of the document\n'.repeat(20_000)
    const hook = renderHook(
      ({ content }) =>
        useDiffCommentDecorator({
          editor: fake.editor,
          filePath: FILE_PATH,
          worktreeId: REVIEW_SURFACE_ID,
          comments,
          onDeleteComment: vi.fn(),
          formatCommentPrompt: (comment) => formatPrompt(content, comment)
        }),
      { initialProps: { content } }
    )

    for (let edit = 1; edit <= 50; edit += 1) {
      hook.rerender({ content: `${content}${edit}` })
    }

    expect(formatPrompt.mock.calls.length).toBe(0)
    expect(renderDiffCommentZoneCard).toHaveBeenCalledTimes(comments.length)
    expect(fake.zones.size).toBe(comments.length)

    const cardContext = vi.mocked(renderDiffCommentZoneCard).mock.calls[0]?.[2]
    expect(cardContext?.formatCommentPromptRef.current?.(comments[0])).toContain('Excerpt:')
    expect(formatPrompt).toHaveBeenLastCalledWith(`${content}50`, comments[0])
  })

  it('refreshes only the open note menu when its excerpt changes', () => {
    const fake = createFakeDiffCommentEditor()
    const comments = [reviewNote(1), reviewNote(2)]
    const formatPrompt = vi.fn(
      (content: string, comment: DecoratedDiffComment) => `${content}:${comment.id}`
    )
    const hook = renderHook(
      ({ content }) =>
        useDiffCommentDecorator({
          editor: fake.editor,
          filePath: FILE_PATH,
          worktreeId: REVIEW_SURFACE_ID,
          comments,
          onDeleteComment: vi.fn(),
          formatCommentPrompt: (comment) => formatPrompt(content, comment)
        }),
      { initialProps: { content: 'initial' } }
    )
    storeFixture.agentSendPopoverTargetMode = {
      id: buildNotesSendTargetModeId([
        'diff-comment-note',
        REVIEW_SURFACE_ID,
        FILE_PATH,
        comments[0].id
      ])
    }
    hook.rerender({ content: 'initial' })
    vi.mocked(renderDiffCommentZoneCard).mockClear()
    formatPrompt.mockClear()

    hook.rerender({ content: 'updated' })

    expect(formatPrompt).toHaveBeenCalledExactlyOnceWith('updated', comments[0])
    expect(renderDiffCommentZoneCard).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renderDiffCommentZoneCard).mock.calls[0]?.[1].id).toBe(comments[0].id)
  })

  it('refreshes closed cards when a same-id note changes its send content', () => {
    const fake = createFakeDiffCommentEditor()
    const comment = { ...reviewNote(1), selectedText: 'old selection' }
    const formatPrompt = vi.fn((comment: DecoratedDiffComment) => comment.selectedText ?? '')
    const hook = renderHook(
      ({ comments }) =>
        useDiffCommentDecorator({
          editor: fake.editor,
          filePath: FILE_PATH,
          worktreeId: REVIEW_SURFACE_ID,
          comments,
          onDeleteComment: vi.fn(),
          formatCommentPrompt: formatPrompt
        }),
      { initialProps: { comments: [comment] } }
    )
    vi.mocked(renderDiffCommentZoneCard).mockClear()

    hook.rerender({ comments: [{ ...comment, selectedText: 'new selection', lineNumber: 20 }] })

    expect(formatPrompt.mock.calls.length).toBe(0)
    expect(renderDiffCommentZoneCard).toHaveBeenCalledTimes(1)
    const rendered = vi.mocked(renderDiffCommentZoneCard).mock.calls[0]
    expect(rendered?.[2].formatCommentPromptRef.current?.(rendered[1])).toBe('new selection')
    expect(fake.zones.size).toBe(1)
  })

  it('joins the commentable-line array once, not once per render, for a stable array', () => {
    const fake = createFakeDiffCommentEditor()
    const comments = [reviewNote(1)]
    const { lines, joins } = countingCommentableLines(4_000)
    const hook = renderDecorator(fake, { commentableLineNumbers: lines, comments })

    for (let render = 1; render < 100; render += 1) {
      hook.rerender({ commentableLineNumbers: lines, comments })
    }

    expect(joins()).toBe(1)
  })

  it('still re-keys on a fresh-but-equal array so the comment set survives a review refresh', () => {
    const fake = createFakeDiffCommentEditor()
    const comments = [reviewNote(1)]
    const hook = renderDecorator(fake, {
      commentableLineNumbers: freshCommentableLines(),
      comments
    })

    fake.emitMouseMove(12)
    expect(isAddButtonVisible(fake.domNode)).toBe(true)

    hook.rerender({ commentableLineNumbers: freshCommentableLines(), comments })

    fake.emitMouseMove(12)
    expect(isAddButtonVisible(fake.domNode)).toBe(true)
    expect(rootCounts.created).toBe(1)
  })

  it('keeps every comment root and view zone alive across value-equal review refreshes', async () => {
    const fake = createFakeDiffCommentEditor()
    const comments = [reviewNote(1), reviewNote(2), reviewNote(3)]
    const hook = renderDecorator(fake, {
      commentableLineNumbers: freshCommentableLines(),
      comments
    })

    expect(rootCounts.created).toBe(3)
    expect(fake.zones.size).toBe(3)

    for (let refresh = 0; refresh < 5; refresh += 1) {
      hook.rerender({ commentableLineNumbers: freshCommentableLines(), comments })
    }
    await flushDeferredUnmounts()

    expect(lifecycleTotals(fake)).toEqual({
      createRootCalls: 3,
      rootUnmounts: 0,
      monacoViewZones: 3
    })

    hook.rerender({ commentableLineNumbers: freshCommentableLines(), comments: comments.slice(1) })
    expect(fake.zones.size).toBe(2)
  })

  it('does not accumulate orphan zones when refreshes interleave with new review comments', async () => {
    const fake = createFakeDiffCommentEditor()
    let comments = [reviewNote(1)]
    const hook = renderDecorator(fake, {
      commentableLineNumbers: freshCommentableLines(),
      comments
    })

    for (let refresh = 2; refresh <= 6; refresh += 1) {
      comments = [...comments, reviewNote(refresh)]
      hook.rerender({ commentableLineNumbers: freshCommentableLines(), comments })
    }
    await flushDeferredUnmounts()

    expect(lifecycleTotals(fake)).toEqual({
      createRootCalls: 6,
      rootUnmounts: 0,
      monacoViewZones: 6
    })
  })

  it('rebuilds the add-button overlay when the commentable lines really change', async () => {
    const fake = createFakeDiffCommentEditor()
    const comments = [reviewNote(1)]
    const hook = renderDecorator(fake, {
      commentableLineNumbers: [10, 11, 12] as readonly number[],
      comments
    })

    fake.emitMouseMove(40)
    expect(isAddButtonVisible(fake.domNode)).toBe(false)

    hook.rerender({ commentableLineNumbers: [10, 11, 12, 40], comments })
    await flushDeferredUnmounts()

    fake.emitMouseMove(40)
    expect(isAddButtonVisible(fake.domNode)).toBe(true)
    expect(lifecycleTotals(fake)).toEqual({
      createRootCalls: 1,
      rootUnmounts: 0,
      monacoViewZones: 1
    })
  })

  it('removes its zones from Monaco when the model swaps under a retained editor', async () => {
    const fake = createFakeDiffCommentEditor()
    const comments = [reviewNote(1)]
    const hook = renderHook(
      ({ monacoModelIdentity }) =>
        useDiffCommentDecorator({
          editor: fake.editor,
          monacoModelIdentity,
          filePath: FILE_PATH,
          worktreeId: REVIEW_SURFACE_ID,
          comments,
          commentableLineNumbers: freshCommentableLines(),
          onAddCommentClick: vi.fn(),
          onDeleteComment: vi.fn()
        }),
      { initialProps: { monacoModelIdentity: 'modified-v1' } }
    )
    const firstZoneIds = [...fake.zones.keys()]

    hook.rerender({ monacoModelIdentity: 'modified-v2' })
    await flushDeferredUnmounts()

    expect(fake.zones.size).toBe(1)
    expect([...fake.zones.keys()]).not.toEqual(firstZoneIds)
    expect(rootCounts.created).toBe(2)
    expect(rootCounts.unmounted).toBe(1)
  })
})

/** No zones exist in the overlay disposal case, so the hook never reaches these. */
const viewZoneAccessor: MonacoEditor.IViewZoneChangeAccessor = {
  addZone: () => '',
  removeZone: () => undefined,
  layoutZone: () => undefined
}

describe('useDiffCommentDecorator model lifecycle', () => {
  it('rebuilds model-scoped resources when a retained editor swaps models', () => {
    const editorDomNode = document.createElement('div')
    document.body.appendChild(editorDomNode)
    const disposeMouseMove = vi.fn()
    const disposeMouseLeave = vi.fn()
    const disposeScroll = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial stand-in for Monaco's ICodeEditor; useDiffCommentDecorator calls only the members defined here, and a real editor needs a laid-out DOM this suite does not build.
    const editor = {
      getDomNode: () => editorDomNode,
      getContainerDomNode: () => editorDomNode,
      getOption: () => 19,
      createDecorationsCollection: () => ({ set: () => {}, clear: () => {} }),
      onMouseMove: () => ({ dispose: disposeMouseMove }),
      onMouseLeave: () => ({ dispose: disposeMouseLeave }),
      onDidScrollChange: () => ({ dispose: disposeScroll }),
      onDidDispose: () => ({ dispose: () => {} }),
      changeViewZones: (callback: (accessor: MonacoEditor.IViewZoneChangeAccessor) => void) =>
        callback(viewZoneAccessor)
    } as unknown as MonacoEditor.ICodeEditor
    const hook = renderHook(
      ({ monacoModelIdentity }) =>
        useDiffCommentDecorator({
          editor,
          monacoModelIdentity,
          filePath: 'notes.ts',
          worktreeId: 'worktree-1',
          comments: [],
          onAddCommentClick: vi.fn(),
          onDeleteComment: vi.fn()
        }),
      { initialProps: { monacoModelIdentity: 'modified-v1' } }
    )
    const firstButton = editorDomNode.querySelector('.orca-diff-comment-add-btn')
    expect(firstButton).not.toBeNull()

    hook.rerender({ monacoModelIdentity: 'modified-v2' })

    const replacementButton = editorDomNode.querySelector('.orca-diff-comment-add-btn')
    expect(replacementButton).not.toBeNull()
    expect(replacementButton).not.toBe(firstButton)
    expect(disposeMouseMove).toHaveBeenCalledOnce()
    expect(disposeMouseLeave).toHaveBeenCalledOnce()
    expect(disposeScroll).toHaveBeenCalledOnce()
  })
})
