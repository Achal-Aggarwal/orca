import {
  getMarkdownFenceRanges,
  isInsideMarkdownFenceRange,
  type MarkdownFenceRanges
} from './markdown-fence-scanner'

export type DetailsHtmlBlock = {
  raw: string
  openingAttributes: string
  inner: string
}

export function scanDetailsHtmlBlock(
  content: string,
  start: number,
  precomputedFenceRanges?: MarkdownFenceRanges,
  unclosedStarts?: Set<number>,
  isInsideFence?: (index: number) => boolean,
  openingEnd?: number
): DetailsHtmlBlock | null {
  let openingTag: string | undefined
  let openingLength: number
  if (openingEnd === undefined) {
    const openingMatch = content.slice(start).match(/^<details\b[^>]*>/i)
    if (!openingMatch) {
      return null
    }
    openingTag = openingMatch[0]
    openingLength = openingTag.length
  } else {
    openingLength = openingEnd - start + 1
  }

  const detailsTagPattern = /<\/?details\b[^>]*>/gi
  detailsTagPattern.lastIndex = openingEnd === undefined ? start : openingEnd + 1
  const fenceRanges = precomputedFenceRanges ?? getMarkdownFenceRanges(content)
  const containsFence =
    isInsideFence ?? ((index: number) => isInsideMarkdownFenceRange(index, fenceRanges))

  let depth = openingEnd === undefined ? 0 : 1
  const openingStarts: number[] | undefined = unclosedStarts
    ? openingEnd === undefined
      ? []
      : [start]
    : undefined

  for (;;) {
    const tagMatch = detailsTagPattern.exec(content)
    if (!tagMatch) {
      if (openingStarts && unclosedStarts) {
        for (const openingStart of openingStarts) {
          unclosedStarts.add(openingStart)
        }
      }
      return null
    }

    const tag = tagMatch[0]
    if (tagMatch.index !== start && containsFence(tagMatch.index)) {
      continue
    }

    const isClosingTag = /^<\/details\b/i.test(tag)

    if (isClosingTag) {
      openingStarts?.pop()
      depth -= 1
      if (depth === 0) {
        const closingEnd = tagMatch.index + tag.length
        return {
          raw: content.slice(start, closingEnd),
          openingAttributes: (openingTag ?? content.slice(start, start + openingLength))
            .replace(/^<details\b/i, '')
            .replace(/>$/u, ''),
          inner: content.slice(start + openingLength, tagMatch.index)
        }
      }
    } else {
      openingStarts?.push(tagMatch.index)
      depth += 1
    }
  }
}
