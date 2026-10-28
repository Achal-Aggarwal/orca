// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []
const lists = [
  ['bullet', '- First\n- Next\n\nOutside', 'li > p'],
  ['ordered', '3. First\n4. Next\n\nOutside', 'li > p'],
  ['task', '- [ ] First\n- [x] Next\n\nOutside', 'li > div > p'],
  ['nested', '- Parent\n  3. First\n  4. Next\n- Last\n\nOutside', 'ol li > p']
] as const

function surface(source: string) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  editorDocument.send.setMarkdown(source, 7)
  return { editorDocument, editor: document.getElementById('editor')!, messages }
}

afterEach(() => {
  stopDocuments.splice(0).forEach((stop) => stop())
  document.body.innerHTML = ''
})

for (const [kind, source, selector] of lists) {
  it.each([
    ['First<br>Second', 'First<br />Second', 'plain'],
    ['<strong>First<br>Second</strong>', '**First<br />Second**', 'STRONG'],
    ['<code>First</code><br><code>Second</code>', '`First`<br />`Second`', 'CODE']
  ])(`keeps ${kind} item soft break inside its list through host save: %s`, (html, text, tag) => {
    const { editorDocument, editor, messages } = surface(source)
    editor.querySelector(selector)!.innerHTML = html
    const live = editor.querySelector(selector)!.outerHTML
    const items = Array.from(editor.querySelectorAll('li')).map((item) => item.textContent)
    const checkboxes = Array.from(editor.querySelectorAll<HTMLInputElement>('input')).map(
      (input) => input.checked
    )
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }))
    const markdown = source.replace('First', text)

    expect(editor.querySelector(selector)!.outerHTML).toBe(live)
    expect(messages.filter((message) => message.type === 'change')).toEqual([
      { type: 'change', generation: 7, markdown }
    ])
    editorDocument.send.setMarkdown(markdown, 8)
    expect(Array.from(editor.querySelectorAll('li')).map((item) => item.textContent)).toEqual(items)
    expect(
      Array.from(editor.querySelectorAll<HTMLInputElement>('input')).map((input) => input.checked)
    ).toEqual(checkboxes)
    expect(editor.querySelector(selector)?.querySelectorAll('br').length).toBe(1)
    expect(editor.querySelector(selector)?.firstElementChild?.tagName ?? 'plain').toBe(
      tag === 'plain' ? 'BR' : tag
    )
    if (tag === 'STRONG') {
      expect(editor.querySelector(selector)?.firstElementChild?.textContent).toBe('FirstSecond')
    }
    expect(editor.querySelector(':scope > p')?.textContent).toBe('Outside')
    expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  })
}

it.each([
  ['- First\n- Next', 'li > p', '<br>'],
  ['3. First\n4. Next', 'li > p', '&lt;br&gt;'],
  ['- [ ] First\n- [x] Next', 'li > div > p', '<br onload="run()">']
])('keeps typed list markup literal: %s', (source, selector, text) => {
  const { editorDocument, editor } = surface(source)
  editor.querySelector(selector)!.textContent = text
  const markdown = editorDocument.send.currentMarkdown()
  editorDocument.send.setMarkdown(markdown, 8)

  expect(editor.querySelector(selector)?.textContent).toBe(text)
  expect(editor.querySelector(selector)?.children.length).toBe(0)
  expect(editor.querySelectorAll('li').length).toBe(2)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it('recognizes attribute-free list breaks while keeping code and paragraph markup literal', () => {
  const { editor } = surface('- `<br>`\n- &#60;br&#62;\n- <BR/>\n- <br onload="run()">\n\n<br />')

  expect(editor.querySelector('li code')?.textContent).toBe('<br>')
  expect(editor.querySelectorAll('li')[1]?.textContent).toBe('<br>')
  expect(editor.querySelectorAll('li')[2]?.querySelector('p')?.innerHTML).toBe('<br>')
  expect(editor.querySelectorAll('li')[3]?.textContent).toBe('<br onload="run()">')
  expect(editor.querySelector('[onload]')).toBe(null)
  expect(editor.lastElementChild?.textContent).toBe('<br />')
  expect(editor.lastElementChild?.children.length).toBe(0)
})

it('keeps cleared task placeholders as empty task Markdown', () => {
  const { editorDocument, editor, messages } = surface('- [ ] First')
  editor.querySelector('li p')!.replaceChildren(document.createElement('br'))
  editor.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })
  )

  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: '- [ ]' }
  ])
  expect(editorDocument.send.currentMarkdown()).toBe('- [ ]')
})

it.each([
  '<span>First</span><br>',
  'First<br>',
  '<span>First</span><br><!-- cursor -->',
  '<span>First</span><br><ul><li><p>Child</p></li></ul>'
])('omits one native LI-root cursor sentinel without changing the live item: %s', (html) => {
  const { editorDocument, editor } = surface('- First\n- Next\n\nOutside')
  const item = editor.querySelector('li')!
  item.innerHTML = html
  const live = item.outerHTML
  expect(editorDocument.send.currentMarkdown()).toBe(
    html.includes('Child') ? '- First\n  - Child\n- Next\n\nOutside' : '- First\n- Next\n\nOutside'
  )
  expect(item.outerHTML).toBe(live)
})

for (const [kind, source, selector] of lists) {
  it.each([
    ['<br>First', '<br />First', 1],
    ['First<br>', 'First<br />', 1],
    ['First<br><br>', 'First<br /><br />', 2],
    ['<br><br>First<br><br>', '<br /><br />First<br /><br />', 4],
    ['<strong><br>First<br></strong>', '**<br />First<br />**', 2],
    ['<br><br>', '<br /><br />', 2]
  ])(
    `preserves authored ${kind} edge breaks on save and stable reopen: %s`,
    (html, text, breaks) => {
      const { editorDocument, editor } = surface(source)
      editor.querySelector(selector)!.innerHTML = html
      const live = editor.querySelector(selector)!.outerHTML
      const markdown = source.replace('First', text)
      expect(editorDocument.send.currentMarkdown()).toBe(markdown)
      expect(editor.querySelector(selector)!.outerHTML).toBe(live)
      editorDocument.send.setMarkdown(markdown, 8)
      expect(editor.querySelector(selector)!.innerHTML).toBe(html)
      expect(editor.querySelector(selector)!.querySelectorAll('br').length).toBe(breaks)
      expect(editorDocument.send.currentMarkdown()).toBe(markdown)
    }
  )
}

it.each([
  ['<br>First<br>', '<br />First'],
  ['First<br><br>', 'First<br /><br />'],
  ['<span>First<br></span><br>', 'First<br /><br />'],
  ['First<br> ', 'First<br />']
])('retains authored direct-item breaks before its single cursor sentinel: %s', (html, text) => {
  const { editorDocument, editor } = surface('- First\n- Next\n\nOutside')
  editor.querySelector('li')!.innerHTML = html
  const markdown = `- ${text}\n- Next\n\nOutside`
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  editorDocument.send.setMarkdown(markdown, 8)
  expect(editor.querySelector('li p')!.querySelectorAll('br').length).toBe(
    text.split('<br />').length - 1
  )
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})
