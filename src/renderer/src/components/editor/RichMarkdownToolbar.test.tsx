// @vitest-environment happy-dom

import { act, Profiler } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RichMarkdownToolbar } from './RichMarkdownToolbar'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const editors: Editor[] = []

afterEach(() => {
  cleanup()
  for (const editor of editors.splice(0)) {
    const element = editor.view.dom.parentElement
    editor.destroy()
    element?.remove()
  }
})

function mountToolbar(content: string, onRender = vi.fn()): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit, TaskList, TaskItem],
    content
  })
  editors.push(editor)
  render(
    <TooltipProvider>
      <Profiler id="toolbar" onRender={onRender}>
        <RichMarkdownToolbar editor={editor} onToggleLink={vi.fn()} onImagePick={vi.fn()} />
      </Profiler>
    </TooltipProvider>
  )
  return editor
}

function selectText(editor: Editor, text: string, range = false): void {
  let found = false
  editor.state.doc.descendants((node, pos) => {
    const index = node.text?.indexOf(text) ?? -1
    if (found || index < 0) {
      return
    }
    const from = pos + index
    act(() => {
      editor.commands.setTextSelection(
        range ? { from, to: from + text.length } : from + Math.min(1, text.length)
      )
    })
    found = true
  })
  if (!found) {
    throw new Error(`Missing editor text: ${text}`)
  }
}

function expectPressed(label: string, pressed: boolean): void {
  const button = screen.getByRole('button', { name: label })
  expect(button.getAttribute('aria-pressed')).toBe(String(pressed))
  expect(button.classList.contains('is-active')).toBe(pressed)
}

describe('rich Markdown toolbar formatting feedback', () => {
  it('follows the current block and marks as the caret moves without changing content', () => {
    const editor = mountToolbar(
      '<h1>Title</h1><p>plain <strong>bold</strong> <em>italic</em> <s>struck</s></p>'
    )
    const original = editor.getHTML()

    selectText(editor, 'Title')
    expectPressed('Heading 1', true)
    expectPressed('Body text', false)
    selectText(editor, 'bold')
    expectPressed('Heading 1', false)
    expectPressed('Body text', true)
    expectPressed('Bold', true)
    expectPressed('Italic', false)
    selectText(editor, 'italic')
    expectPressed('Bold', false)
    expectPressed('Italic', true)
    selectText(editor, 'struck')
    expectPressed('Strike', true)
    selectText(editor, 'plain')
    expectPressed('Bold', false)
    expectPressed('Italic', false)
    expectPressed('Strike', false)
    expect(editor.getHTML()).toBe(original)
    expect(screen.getByRole('button', { name: 'Image' }).hasAttribute('aria-pressed')).toBe(false)
  })

  it('updates after toolbar commands, undo, redo and stored-mark changes', () => {
    const editor = mountToolbar('<p>selected words</p>')
    selectText(editor, 'selected', true)

    fireEvent.click(screen.getByRole('button', { name: 'Bold' }))
    expectPressed('Bold', true)
    expect(editor.getHTML()).toContain('<strong>selected</strong>')

    act(() => editor.commands.undo())
    expectPressed('Bold', false)
    expect(editor.getHTML()).toBe('<p>selected words</p>')
    act(() => editor.commands.redo())
    expectPressed('Bold', true)

    selectText(editor, 'words')
    act(() => editor.commands.toggleItalic())
    expectPressed('Italic', true)
    act(() => editor.commands.toggleItalic())
    expectPressed('Italic', false)
  })

  it('reflects nested lists and quotes independently of inline formatting', () => {
    const editor = mountToolbar('<p>item</p>')
    selectText(editor, 'item')
    act(() => editor.commands.toggleBulletList())
    expectPressed('Bullet list', true)
    expectPressed('Numbered list', false)
    act(() => editor.commands.toggleOrderedList())
    expectPressed('Bullet list', false)
    expectPressed('Numbered list', true)
    act(() => editor.commands.toggleTaskList())
    expectPressed('Numbered list', false)
    expectPressed('Checklist', true)
    act(() =>
      editor.commands.setContent('<blockquote><ul><li><p>quoted item</p></li></ul></blockquote>')
    )
    selectText(editor, 'quoted item')
    expectPressed('Quote', true)
    expectPressed('Bullet list', true)
    expectPressed('Checklist', false)
  })

  it('does not rerender while typing or publishing metadata if formatting stays the same', () => {
    const onRender = vi.fn()
    const editor = mountToolbar('<p>unchanged formatting</p>', onRender)
    selectText(editor, 'unchanged')
    onRender.mockClear()

    act(() => {
      for (const text of ['a', 'b', 'c', 'd']) {
        editor.commands.insertContent(text)
      }
      editor.view.dispatch(editor.state.tr.setMeta('unrelated', true))
    })
    expect(onRender).not.toHaveBeenCalled()

    act(() => editor.commands.toggleBold())
    expectPressed('Bold', true)
    expect(onRender).toHaveBeenCalledTimes(1)
  })
})
