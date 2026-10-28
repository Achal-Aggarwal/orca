import { escapeAttr, escapeHtml, isSafeUrl } from './markdown-escaping'

// Build global exec regex per recursive call: shared lastIndex would leak between nested parses. Escape text between recognized inline forms.
export function renderInline(text: string, allowLineBreaks = false): string {
  const pattern =
    /(!\[[^\]]*\]\([^)]+\)|`[^`]+`|~~[^~]+~~|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<]+|<[bB][rR][ \t]*\/?>)/g
  let output = ''
  let lastIndex = 0
  let match = pattern.exec(text)
  while (match !== null) {
    output += escapeHtml(text.slice(lastIndex, match.index))
    const token = match[0]
    const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (token.startsWith('<')) {
      output += allowLineBreaks ? '<br />' : escapeHtml(token)
    } else if (image && isSafeUrl(image[2])) {
      output += `<img src="${escapeAttr(image[2]!)}" alt="${escapeAttr(image[1] ?? '')}" />`
    } else if (link && isSafeUrl(link[2])) {
      output += `<a href="${escapeAttr(link[2]!)}">${renderInline(link[1]!, allowLineBreaks)}</a>`
    } else if (/^https?:\/\//i.test(token)) {
      output += `<a href="${escapeAttr(token)}">${escapeHtml(token)}</a>`
    } else if (token.startsWith('`')) {
      output += `<code>${escapeHtml(token.slice(1, -1))}</code>`
    } else if (token.startsWith('~~')) {
      output += `<s>${renderInline(token.slice(2, -2), allowLineBreaks)}</s>`
    } else if (token.startsWith('**') || token.startsWith('__')) {
      output += `<strong>${renderInline(token.slice(2, -2), allowLineBreaks)}</strong>`
    } else {
      output += `<em>${renderInline(token.slice(1, -1), allowLineBreaks)}</em>`
    }
    lastIndex = pattern.lastIndex
    match = pattern.exec(text)
  }
  return output + escapeHtml(text.slice(lastIndex))
}
