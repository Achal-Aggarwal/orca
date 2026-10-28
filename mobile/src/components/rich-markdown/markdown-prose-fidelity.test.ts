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

function proseDocument() {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editor = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editor.stop)
  editor.send.setMarkdown('Placeholder\n\nUnrelated', 7)
  const surface = document.getElementById('editor')!
  const reloadAfterUnrelatedEdit = () => {
    surface.lastElementChild!.append('!')
    surface.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '!' })
    )
    const message = messages.at(-1)
    expect(message?.type).toBe('change')
    if (message?.type !== 'change') {
      throw new Error('The unrelated edit did not reach the host')
    }
    expect(message.generation).toBe(7)
    editor.send.setMarkdown(message.markdown, 7)
    return surface.firstElementChild!
  }
  return { surface, reloadAfterUnrelatedEdit }
}

it.each([
  '**literal**',
  '\\*literal*',
  '\\&amp;',
  '\\[label](target)',
  'C:\\tmp\\folder',
  '\\\\',
  'one\\|two',
  '_literal_ and *literal*',
  '~~literal~~',
  '`literal`',
  '[literal](https://example.com)',
  '![literal](https://example.com/pixel.png)',
  'a &amp; &#38; &lt;tag&gt; &#x1f600;',
  'R&D <tag> "quoted" and \'apostrophe\'',
  'https://example.com',
  '# Heading',
  '- List item',
  '+ List item',
  '12. List item',
  '12) List item',
  '- [ ] Task',
  '> Quoted',
  '---',
  '```html',
  '~~~',
  'ordinary words and sentence punctuation. Done!'
])('retains literal prose %j through unrelated edits and repeated host reloads', (literal) => {
  const { surface, reloadAfterUnrelatedEdit } = proseDocument()
  surface.firstElementChild!.textContent = literal
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const paragraph = reloadAfterUnrelatedEdit()
    expect(paragraph.tagName).toBe('P')
    expect(paragraph.textContent).toBe(literal)
    expect(paragraph.children).toHaveLength(0)
    expect(surface.lastElementChild!.textContent).toBe(`Unrelated${'!'.repeat(cycle + 1)}`)
  }
})

it.each(['strong', 'em', 's', 'code', 'a'])('retains real %s marks around literal prose', (tag) => {
  const { surface, reloadAfterUnrelatedEdit } = proseDocument()
  const mark = document.createElement(tag)
  mark.textContent = tag === 'code' ? '*literal*' : '**literal** and &amp;'
  if (tag === 'a') {
    mark.setAttribute('href', '../notes.md#topic')
  }
  surface.firstElementChild!.replaceChildren(mark)
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const paragraph = reloadAfterUnrelatedEdit()
    expect(paragraph.textContent).toBe(mark.textContent)
    expect(paragraph.children).toHaveLength(1)
    expect(paragraph.firstElementChild!.tagName.toLowerCase()).toBe(tag)
    if (tag === 'a') {
      expect(paragraph.firstElementChild!.getAttribute('href')).toBe('../notes.md#topic')
    }
  }
})

it('keeps split native text nodes from joining into Markdown syntax', () => {
  const { surface, reloadAfterUnrelatedEdit } = proseDocument()
  const literal = '12. https://example.com **literal**'
  surface.firstElementChild!.replaceChildren(
    ...Array.from(literal, (char) => document.createTextNode(char))
  )
  const paragraph = reloadAfterUnrelatedEdit()
  expect(paragraph.tagName).toBe('P')
  expect(paragraph.textContent).toBe(literal)
  expect(paragraph.children).toHaveLength(0)
})

it('serializes a bare top-level native text node as literal prose', () => {
  const { surface, reloadAfterUnrelatedEdit } = proseDocument()
  surface.firstElementChild!.replaceWith(document.createTextNode('**literal** &amp;'))
  const paragraph = reloadAfterUnrelatedEdit()
  expect(paragraph.tagName).toBe('P')
  expect(paragraph.textContent).toBe('**literal** &amp;')
  expect(paragraph.children).toHaveLength(0)
})

it('keeps BR-separated literal table and block markers inside the paragraph', () => {
  const { surface, reloadAfterUnrelatedEdit } = proseDocument()
  const lines = ['one | two', '--- | ---', '# Heading', '- List item']
  const content = lines.flatMap((line, index) =>
    index
      ? [document.createElement('br'), document.createTextNode(line)]
      : [document.createTextNode(line)]
  )
  surface.firstElementChild!.replaceChildren(...content)
  const paragraph = reloadAfterUnrelatedEdit()
  expect(paragraph.tagName).toBe('P')
  expect(paragraph.textContent).toBe(lines.join(''))
  expect(Array.from(paragraph.children).map((child) => child.tagName)).toEqual(['BR', 'BR', 'BR'])
})
