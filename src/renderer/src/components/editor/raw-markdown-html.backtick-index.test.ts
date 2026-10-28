import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const key = 'a'.repeat(32)

afterEach(() => vi.restoreAllMocks())

describe('raw Markdown backtick delimiter lookup', () => {
  it.each([1_000, 10_000])(
    'indexes an unmatched run of %i backticks without building suffix needles',
    (count) => {
      const ticks = '`'.repeat(count)
      const codec = createRichMarkdownEditorCodec(key)
      const repeat = vi.spyOn(String.prototype, 'repeat')
      const result = encodeRawMarkdownHtmlForRichEditor(`prefix ${ticks} <b>tail</b>`, codec)
      expect(result).toBe(
        `prefix ${ticks} ${codec.transport.create('inline-html', '<b>')}tail${codec.transport.create('inline-html', '</b>')}`
      )
      expect(repeat).not.toHaveBeenCalled()
    }
  )

  it.each([
    'before ` <b>code</b> ` after',
    'before `` <b>code</b> `` after',
    'before ``literal <b>code</b>` after',
    'before \\` <b>code</b> ` after',
    'before ` \n\n <b>code</b> ` after',
    'before ` \n```\n<b>code</b>\n```\n ` after',
    '```html\n<b>code</b>\n```'
  ])('preserves existing source preprocessing for %s', (source) => {
    expect(encodeRawMarkdownHtmlForRichEditor(source, createRichMarkdownEditorCodec(key))).toBe(
      source
    )
  })

  it('encodes HTML after an unterminated span and matches exact-length closing runs', () => {
    const codec = createRichMarkdownEditorCodec(key)
    expect(encodeRawMarkdownHtmlForRichEditor('before ` <b>tail</b>', codec)).toBe(
      `before \` ${codec.transport.create('inline-html', '<b>')}tail${codec.transport.create('inline-html', '</b>')}`
    )
    const source = 'before `` <b>code</b> ` still code `` <i>tail</i>'
    expect(encodeRawMarkdownHtmlForRichEditor(source, codec)).toBe(
      `before \`\` <b>code</b> \` still code \`\` ${codec.transport.create('inline-html', '<i>')}tail${codec.transport.create('inline-html', '</i>')}`
    )
  })
})
