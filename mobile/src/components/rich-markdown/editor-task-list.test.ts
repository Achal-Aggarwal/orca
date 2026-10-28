// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import {
  startRichMarkdownEditorDocument,
  stopRichMarkdownEditorDocument
} from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { createRichMarkdownEditorScope } from './document-scope'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import { taskListCommandHtml } from './editor-task-list'
import { blockMarkdown } from './html-block-markdown'
import { markdownToHtml } from './markdown-to-html'
import { runCommand } from './editor-commands'
import type { RichMarkdownEditorScope } from './document-scope'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const scopes: RichMarkdownEditorScope[] = []

afterEach(() => {
  scopes.splice(0).forEach(stopRichMarkdownEditorDocument)
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

function selectContent(html: string, partial = false) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const scope = createRichMarkdownEditorScope({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  startRichMarkdownEditorDocument(scope)
  scopes.push(scope)
  const surface = document.getElementById('editor')!
  surface.innerHTML = html
  surface.focus()
  const range = document.createRange()
  if (partial) {
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()!
    range.setStart(text, 1)
    range.setEnd(text, 3)
  } else {
    range.selectNodeContents(surface)
  }
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  messages.length = 0
  return { scope, surface, messages }
}

it.each([
  ['<p>first</p>', '- [ ] first', ['first']],
  ['<p>first</p>\n<p>second</p>', '- [ ] first\n- [ ] second', ['first', 'second']],
  ['<p>first<br>second</p>', '- [ ] first\n- [ ] second', ['first', 'second']],
  [
    '<p><strong>first<br>second</strong></p>',
    '- [ ] **first**\n- [ ] **second**',
    ['first', 'second']
  ],
  [
    '<p><b>bold</b> and <i>italic</i> and <strike>gone</strike></p>',
    '- [ ] **bold** and *italic* and ~~gone~~',
    ['bold and italic and gone']
  ],
  [
    '<p>before <code>code literal</code> after</p>',
    '- [ ] before `code literal` after',
    ['before code literal after']
  ],
  [
    '<p>before <a href="https://example.com">link</a> after</p>',
    '- [ ] before [link](https://example.com) after',
    ['before link after']
  ],
  [
    '<p># Heading</p><p>- literal</p><p>&gt; quote</p>',
    '- [ ] # Heading\n- [ ] - literal\n- [ ] > quote',
    ['# Heading', '- literal', '> quote']
  ],
  ['<p>Unmatched * and [ and `</p>', '- [ ] Unmatched * and [ and `', ['Unmatched * and [ and `']]
])('prepares complete paragraphs %j as faithful task markup', (html, markdown, texts) => {
  const { scope, surface, messages } = selectContent(html)
  const before = surface.innerHTML
  const prepared = taskListCommandHtml(scope)
  expect(prepared).not.toBeNull()
  const preview = document.createElement('div')
  preview.innerHTML = prepared ?? ''
  expect(preview.querySelectorAll('input[type="checkbox"]').length).toBe(texts.length)
  expect(blockMarkdown(preview.firstChild!)).toBe(markdown)
  preview.innerHTML = markdownToHtml(scope, markdown)
  expect(Array.from(preview.querySelectorAll('li')).map((item) => item.textContent)).toEqual(texts)
  expect(surface.innerHTML).toBe(before)
  expect(messages).toEqual([])
})

it('accepts complete text-node boundaries without expanding the live range', () => {
  const { scope, surface } = selectContent('<p><strong>selected</strong></p>')
  const text = surface.querySelector('strong')!.firstChild!
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, text.textContent!.length)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  expect(taskListCommandHtml(scope)).toContain('<p><strong>selected</strong></p>')
  const current = window.getSelection()!.getRangeAt(0)
  expect(current.startContainer).toBe(text)
  expect(current.startOffset).toBe(0)
  expect(current.endContainer).toBe(text)
  expect(current.endOffset).toBe(text.textContent!.length)
})

it.each([
  ['<p>partial selected text</p>', true],
  ['<p>first</p><p>second</p>', true],
  ['<p><strong>partial selected text</strong></p>', true],
  ['<p><code>partial selected text</code></p>', true],
  ['<h1>Heading</h1>', false],
  ['<ul><li>item</li></ul>', false],
  ['<blockquote><p>quote</p></blockquote>', false],
  ['<pre><code>code</code></pre>', false],
  ['<p>before <img src="/pixel.png" alt="pixel"> after</p>', false],
  ['<p>before</p><hr><p>after</p>', false],
  ['<table><tr><td>cell</td></tr></table>', false],
  ['<p>one<br><br>two</p>', false],
  ['<p>one<br></p>', false],
  ['<p> padded </p>', false],
  ['<p>**literal**</p>', false],
  ['<p>`literal`</p>', false],
  ['<p>[literal](https://example.com)</p>', false],
  ['<p>a &amp;amp; &amp;lt;tag&amp;gt;</p>', false],
  ['<p>https://example.com</p>', false],
  ['<p>one<!-- private -->two</p>', false],
  ['<p><strong>one <em>two</em></strong></p>', false],
  ['<p><span style="color: red">text</span></p>', false],
  ['<p>text<span contenteditable="false">control</span></p>', false],
  ['outside<p>paragraph</p>', false]
])('leaves unsupported selection %j and host output unchanged', async (html, partial) => {
  const { scope, surface, messages } = selectContent(html, partial)
  const before = surface.innerHTML
  const selected = window.getSelection()!.toString()
  await runCommand(scope, 'taskList')
  expect(surface.innerHTML).toBe(before)
  expect(window.getSelection()!.toString()).toBe(selected)
  expect(messages).toEqual([])
})

it('keeps the existing collapsed Task placeholder', () => {
  const { scope, surface } = selectContent('<p>before after</p>')
  const range = document.createRange()
  range.setStart(surface.querySelector('p')!.firstChild!, 7)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  const preview = document.createElement('div')
  preview.innerHTML = taskListCommandHtml(scope) ?? ''
  expect(blockMarkdown(preview.firstChild!)).toBe('- [ ] Task')
  expect(preview.querySelector('input')?.disabled).toBe(false)
})
