import { selectedInlineFragments } from './editor-selection'
import { editorElement } from './editor-surface'
import { inlineChildren } from './html-inline-markdown'
import { renderInline } from './markdown-inline-render'
import { renderTaskListItem } from './markdown-list-render'
import type { RichMarkdownEditorScope } from './document-scope'

function containsContent(fragment: DocumentFragment): boolean {
  return Boolean(fragment.textContent || fragment.querySelector('br'))
}

function coversParagraph(
  scope: RichMarkdownEditorScope,
  range: Range,
  paragraph: Element
): boolean {
  if (paragraph.contains(range.startContainer)) {
    const before = scope.getDocument().createRange()
    before.selectNodeContents(paragraph)
    before.setEnd(range.startContainer, range.startOffset)
    if (containsContent(before.cloneContents())) {
      return false
    }
  }
  if (paragraph.contains(range.endContainer)) {
    const after = scope.getDocument().createRange()
    after.selectNodeContents(paragraph)
    after.setStart(range.endContainer, range.endOffset)
    if (containsContent(after.cloneContents())) {
      return false
    }
  }
  return true
}

function comparableInlineContent(scope: RichMarkdownEditorScope, html: string): Element {
  const paragraph = scope.getDocument().createElement('p')
  paragraph.innerHTML = html
  for (const mark of paragraph.querySelectorAll('b,i,del,strike')) {
    const tag = mark.tagName.toLowerCase()
    const replacement = scope
      .getDocument()
      .createElement(tag === 'b' ? 'strong' : tag === 'i' ? 'em' : 's')
    for (const attribute of mark.attributes) {
      replacement.setAttribute(attribute.name, attribute.value)
    }
    replacement.append(...mark.childNodes)
    mark.replaceWith(replacement)
  }
  paragraph.normalize()
  return paragraph
}

export function taskListCommandHtml(scope: RichMarkdownEditorScope): string | null {
  const taskList = (items: string[]) => `<ul data-type="taskList">${items.join('')}</ul>`
  const selection = scope.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return taskList([renderTaskListItem(scope, 'Task')])
  }
  const range = selection.getRangeAt(0)
  let expectedItems = 0
  for (const node of editorElement(scope).childNodes) {
    if (
      !range.intersectsNode(node) ||
      (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
    ) {
      continue
    }
    if (
      !(node instanceof Element) ||
      node.tagName.toLowerCase() !== 'p' ||
      !coversParagraph(scope, range, node)
    ) {
      return null
    }
    if (
      node.querySelector(
        'p,div,h1,h2,h3,h4,h5,h6,blockquote,pre,ul,ol,table,img,input,hr,[contenteditable="false"]'
      )
    ) {
      return null
    }
    if (scope.getDocument().createTreeWalker(node, NodeFilter.SHOW_COMMENT).nextNode()) {
      return null
    }
    expectedItems += node.querySelectorAll('br').length + 1
  }
  if (!expectedItems) {
    return null
  }
  const items: string[] = []
  for (const fragment of selectedInlineFragments(scope)) {
    const container = scope.getDocument().createElement('p')
    container.appendChild(fragment)
    const original = comparableInlineContent(scope, container.innerHTML)
    const reloaded = comparableInlineContent(scope, renderInline(inlineChildren(container).trim()))
    if (!original.isEqualNode(reloaded)) {
      return null
    }
    items.push(renderTaskListItem(scope, container.innerHTML))
  }
  return items.length === expectedItems ? taskList(items) : null
}
