import { escapeMarkdownText } from './markdown-escaping'

/** A node's text with non-breaking spaces turned back into the spaces the source wrote. */
export function textContent(node: Node): string {
  return (node.textContent ?? '').replace(/ /g, ' ')
}

// Serialize task label as empty: checkbox chrome is replaced by list writer’s Markdown marker.
export function inlineMarkdown(node: Node | null | undefined, lineBreak = '\n'): string {
  if (!node) {
    return ''
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const markdown = escapeMarkdownText(textContent(node))
    return lineBreak === '\n' ? markdown : markdown.replace(/\r\n?|\n/g, lineBreak)
  }
  if (!(node instanceof Element)) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (tag === 'br') {
    return lineBreak
  }
  if (tag === 'strong' || tag === 'b') {
    return `**${inlineChildren(node, lineBreak)}**`
  }
  if (tag === 'em' || tag === 'i') {
    return `*${inlineChildren(node, lineBreak)}*`
  }
  if (tag === 's' || tag === 'del' || tag === 'strike') {
    return `~~${inlineChildren(node, lineBreak)}~~`
  }
  if (tag === 'code' && node.parentElement && node.parentElement.tagName.toLowerCase() !== 'pre') {
    return `\`${textContent(node)}\``
  }
  if (tag === 'a') {
    return `[${inlineChildren(node, lineBreak)}](${node.getAttribute('href') ?? ''})`
  }
  if (tag === 'img') {
    return `![${node.getAttribute('alt') ?? ''}](${node.getAttribute('src') ?? ''})`
  }
  if (tag === 'label') {
    return ''
  }
  return inlineChildren(node, lineBreak)
}

export function inlineChildren(element: Element, lineBreak = '\n'): string {
  return Array.from(element.childNodes)
    .map((child) => inlineMarkdown(child, lineBreak))
    .join('')
}
