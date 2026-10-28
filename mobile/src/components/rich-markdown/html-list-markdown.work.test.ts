// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import { directNestedLists, listMarkdown } from './html-list-markdown'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function nodeCount(node: Node): number {
  return 1 + Array.from(node.childNodes).reduce((count, child) => count + nodeCount(child), 0)
}

describe('mobile list serialization work', () => {
  it.each([100, 1_000])(
    'serializes a nested list with %i leaves without copying descendant DOM',
    (leaves) => {
      const levels = 12
      const markdown = [
        ...Array.from({ length: levels }, (_, level) => `${'  '.repeat(level)}- Level ${level}`),
        ...Array.from({ length: leaves }, (_, index) => `${'  '.repeat(levels)}- Leaf ${index}`)
      ].join('\n')
      document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
      const posted: MobileRichMarkdownEditorMessage[] = []
      const mounted = createRichMarkdownEditorDocument(
        quietRichMarkdownEditorHost({
          postToHost: (message) => posted.push(message),
          keyboardInsetSource: () => null
        })
      )
      try {
        mounted.send.setMarkdown(markdown, 1)
        posted.length = 0
        const editor = document.getElementById('editor')!
        const originalMarkup = editor.innerHTML
        let copiedNodes = 0
        let cloneDepth = 0
        const clone = Element.prototype.cloneNode
        vi.spyOn(Element.prototype, 'cloneNode').mockImplementation(function (
          this: Element,
          deep?: boolean
        ) {
          cloneDepth += 1
          try {
            const result = clone.call(this, deep)
            if (cloneDepth === 1) {
              copiedNodes += deep ? nodeCount(result) : 1
            }
            return result
          } finally {
            cloneDepth -= 1
          }
        })
        editor.dispatchEvent(new Event('input'))
        console.info('MOBILE_LIST_DOM_COPIES', JSON.stringify({ leaves, levels, copiedNodes }))
        expect(posted).toEqual([{ type: 'change', markdown, generation: 1 }])
        expect(editor.innerHTML).toBe(originalMarkup)
        expect(copiedNodes).toBe(0)
      } finally {
        mounted.stop()
      }
    }
  )

  it('preserves live task state, inline marks and lists wrapped by browser-created elements', () => {
    const list = document.createElement('ul')
    list.setAttribute('data-type', 'taskList')
    list.innerHTML =
      '<li><label><input type="checkbox"><span>chrome</span></label><div><strong>Parent</strong> <a href="https://example.com"><em>link</em></a><section><ol start="3"><li><p><code>child</code></p></li></ol></section> after</div></li>'
    const checkbox = list.querySelector('input')!
    checkbox.checked = true
    const before = list.innerHTML
    expect(listMarkdown(list, 0)).toBe(
      '- [x] **Parent** [*link*](https://example.com) after\n  3. `child`'
    )
    expect(list.innerHTML).toBe(before)
    expect(checkbox.checked).toBe(true)
  })

  it('keeps the original list ownership for nested lists without an intervening list item', () => {
    const item = document.createElement('li')
    item.innerHTML = '<div><ul><div><ol></ol></div><li><ul></ul></li></ul></div><ol></ol>'
    const lists = Array.from(item.querySelectorAll('ul, ol'))
    expect(directNestedLists(item)).toEqual([lists[0], lists[1], lists[3]])
  })

  it('excludes a list nested inside code from the parent code text', () => {
    const list = document.createElement('ul')
    list.innerHTML = '<li><code>before<ul><li>child</li></ul>after<label>chrome</label></code></li>'
    expect(listMarkdown(list, 0)).toBe('- `beforeafter`\n  - child')
  })
})
