/** A node's text with non-breaking spaces turned back into the spaces the source wrote. */
export function textContent(node: Node, skipNestedLists = false): string {
  if (skipNestedLists && node instanceof Element) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'ul' || tag === 'ol' || tag === 'label') {
      return ''
    }
    return Array.from(node.childNodes)
      .map((child) => textContent(child, true))
      .join('')
  }
  return (node.textContent ?? '').replace(/ /g, ' ')
}

// Serialize task label as empty: checkbox chrome is replaced by list writer’s Markdown marker.
export function inlineMarkdown(node: Node | null | undefined, skipNestedLists = false): string {
  if (!node) {
    return ''
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return textContent(node)
  }
  if (!(node instanceof Element)) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (skipNestedLists && (tag === 'ul' || tag === 'ol')) {
    return ''
  }
  if (tag === 'br') {
    return '\n'
  }
  if (tag === 'strong' || tag === 'b') {
    return `**${inlineChildren(node, skipNestedLists)}**`
  }
  if (tag === 'em' || tag === 'i') {
    return `*${inlineChildren(node, skipNestedLists)}*`
  }
  if (tag === 's' || tag === 'del' || tag === 'strike') {
    return `~~${inlineChildren(node, skipNestedLists)}~~`
  }
  if (tag === 'code' && node.parentElement && node.parentElement.tagName.toLowerCase() !== 'pre') {
    return `\`${textContent(node, skipNestedLists)}\``
  }
  if (tag === 'a') {
    return `[${inlineChildren(node, skipNestedLists)}](${node.getAttribute('href') ?? ''})`
  }
  if (tag === 'img') {
    return `![${node.getAttribute('alt') ?? ''}](${node.getAttribute('src') ?? ''})`
  }
  if (tag === 'label') {
    return ''
  }
  return inlineChildren(node, skipNestedLists)
}

export function inlineChildren(element: Element, skipNestedLists = false): string {
  return Array.from(element.childNodes)
    .map((child) => inlineMarkdown(child, skipNestedLists))
    .join('')
}
