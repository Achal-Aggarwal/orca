// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []
const original = '| Header | Other |\n| --- | --- |\n| First | Right |\n\nOutside'

afterEach(() => {
  stopDocuments.splice(0).forEach((stop) => stop())
  document.body.innerHTML = ''
})

function surface() {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  editorDocument.send.setMarkdown(original, 7)
  return { editorDocument, editor: document.getElementById('editor')!, messages }
}

it.each([
  ['First<br>Second', 'First<br />Second', 'plain'],
  ['<strong>First<br>Second</strong>', '**First<br />Second**', 'STRONG'],
  ['<em>First<br>Second</em>', '*First<br />Second*', 'EM'],
  ['<s>First<br>Second</s>', '~~First<br />Second~~', 'S'],
  ['<a href="/docs">First<br>Second</a>', '[First<br />Second](/docs)', 'A'],
  ['<code>First</code><br><code>Second</code>', '`First`<br />`Second`', 'CODE']
])('keeps a cell line break in its own table row through host save: %s', (html, cell, tag) => {
  const { editorDocument, editor, messages } = surface()
  editor.querySelector('td')!.innerHTML = html
  const live = editor.innerHTML
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }))
  const markdown = original.replace('| First |', `| ${cell} |`)

  expect(editor.innerHTML).toBe(live)
  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown }
  ])
  editorDocument.send.setMarkdown(markdown, 8)
  expect(
    Array.from(editor.querySelectorAll('tr')).map((row) =>
      Array.from(row.children).map((node) => node.textContent)
    )
  ).toEqual([
    ['Header', 'Other'],
    ['FirstSecond', 'Right']
  ])
  expect(editor.querySelector('td')?.querySelectorAll('br').length).toBe(1)
  expect(editor.querySelector('td')?.firstElementChild?.tagName ?? 'plain').toBe(
    tag === 'plain' ? 'BR' : tag
  )
  if (tag !== 'plain' && tag !== 'CODE') {
    expect(editor.querySelector('td')?.firstElementChild?.textContent).toBe('FirstSecond')
  }
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it.each(['<br>', '&lt;br&gt;', '<br onload="run()">'])(
  'keeps typed table markup literal: %s',
  (text) => {
    const { editorDocument, editor } = surface()
    editor.querySelector('td')!.textContent = text
    const markdown = editorDocument.send.currentMarkdown()
    editorDocument.send.setMarkdown(markdown, 8)

    expect(editor.querySelector('td')?.textContent).toBe(text)
    expect(editor.querySelector('td')?.children.length).toBe(0)
    expect(editor.querySelectorAll('tr').length).toBe(2)
    expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  }
)

it('recognizes attribute-free table breaks without interpreting code or paragraph HTML', () => {
  const { editorDocument, editor } = surface()
  editorDocument.send.setMarkdown(
    '| `<br>` | &#60;br&#62; |\n| --- | --- |\n| <BR/> | <br onload="run()"> |\n\n<br />',
    8
  )

  expect(editor.querySelector('th code')?.textContent).toBe('<br>')
  expect(editor.querySelectorAll('th')[1]?.textContent).toBe('<br>')
  expect(editor.querySelectorAll('td')[0]?.innerHTML).toBe('<br>')
  expect(editor.querySelectorAll('td')[1]?.textContent).toBe('<br onload="run()">')
  expect(editor.querySelector('[onload]')).toBe(null)
  expect(editor.lastElementChild?.textContent).toBe('<br />')
  expect(editor.lastElementChild?.children.length).toBe(0)
})
