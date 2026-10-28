// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []

afterEach(() => {
  stopDocuments.splice(0).forEach((stop) => stop())
  document.body.innerHTML = ''
})

function mount(markdown: string) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editor = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editor.stop)
  editor.send.setMarkdown(markdown, 7)
  const surface = document.getElementById('editor')!
  const checks = () =>
    Array.from(surface.querySelectorAll<HTMLInputElement>('input')).map((input) => input.checked)
  return { surface, messages, send: editor.send, checks }
}

it.each([
  ['- [ ]', '- [ ]', [false]],
  ['- [x]', '- [x]', [true]],
  ['- [X]', '- [x]', [true]],
  ['- [ ]   ', '- [ ]', [false]],
  ['- [ ] Parent\n  - [x]', '- [ ] Parent\n  - [x]', [false, true]]
])(
  'reloads the empty task in %j without turning its marker into prose',
  (source, saved, checks) => {
    const editor = mount(source)
    expect(editor.checks()).toEqual(checks)
    expect(editor.send.currentMarkdown()).toBe(saved)
    expect(editor.messages.filter((message) => message.type === 'change')).toEqual([])
  }
)

it.each([
  ['- [ ] First task', 0, '- [ ]', [false]],
  ['- [x] Checked task', 0, '- [x]', [true]],
  ['- [ ] Parent\n  - [x] Nested task', 1, '- [ ] Parent\n  - [x]', [false, true]]
])('preserves task state when its text is cleared in %j', (source, paragraph, saved, checks) => {
  const editor = mount(source)
  editor.surface.querySelectorAll('p')[paragraph].replaceChildren(document.createElement('br'))
  editor.surface.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })
  )
  expect(editor.messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: saved }
  ])
  editor.send.setMarkdown(saved, 8)
  expect(editor.checks()).toEqual(checks)
  const input = Array.from(editor.surface.querySelectorAll<HTMLInputElement>('input')).at(-1)!
  const wasChecked = input.checked
  input.click()
  expect(input.checked).toBe(!wasChecked)
  expect(editor.messages.filter((message) => message.type === 'change')).toHaveLength(2)
  expect(editor.messages.at(-1)).toMatchObject({ type: 'change', generation: 8 })
  editor.send.setEditable(false)
  input.click()
  expect(input.checked).toBe(!wasChecked)
  expect(input.disabled).toBe(true)
  expect(editor.messages.filter((message) => message.type === 'change')).toHaveLength(2)
})

it('keeps incomplete task markers and bracket-prefixed text as ordinary list text', () => {
  const markdown = '- [ ]suffix\n- [x]suffix\n- []\n- [z]'
  const editor = mount(markdown)
  expect(editor.checks()).toEqual([])
  expect(editor.send.currentMarkdown()).toBe(markdown)
})
