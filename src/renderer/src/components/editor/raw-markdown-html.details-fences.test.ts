import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createDetailsMatcher, matchDetailsHtmlBlock } from './details-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import * as fenceScanner from './markdown-fence-scanner'

vi.mock('./markdown-fence-scanner', { spy: true })

const key = '0123456789abcdef0123456789abcdef'

afterEach(() => vi.restoreAllMocks())

describe('raw Markdown details fence scanning', () => {
  it('scans the document once for sibling toggles', () => {
    const content = Array.from(
      { length: 50 },
      (_, index) => `<details><summary>Section ${index}</summary>\n\nBody ${index}\n\n</details>`
    ).join('\n\n')
    const scanFences = vi.mocked(fenceScanner.getMarkdownFenceRanges)
    scanFences.mockClear()

    expect(encodeRawMarkdownHtmlForRichEditor(content, createRichMarkdownEditorCodec(key))).toBe(
      content
    )
    expect(scanFences).toHaveBeenCalledTimes(1)
  })

  it.each([
    'Plain text\n\nMore plain text',
    '<details',
    '<details open\nStill no opening tag terminator',
    '```html\n<details><summary>Code</summary>\n\nBody\n\n</details>\n```'
  ])('does not scan fences when no opening tag is matched: %j', (content) => {
    const scanFences = vi.mocked(fenceScanner.getMarkdownFenceRanges)
    scanFences.mockClear()
    expect(encodeRawMarkdownHtmlForRichEditor(content, createRichMarkdownEditorCodec(key))).toBe(
      content
    )
    expect(scanFences).toHaveBeenCalledTimes(0)
  })

  it('preserves nested and mixed-case editable toggles', () => {
    const content =
      '<DeTaIlS open><SuMmArY>Outer</SuMmArY>\n\n<details><summary>Inner</summary>\n\nBody\n\n</details>\n\n</DeTaIlS>'
    expect(encodeRawMarkdownHtmlForRichEditor(content, createRichMarkdownEditorCodec(key))).toBe(
      content
    )
  })

  it('uses each document’s own fences when the codec is reused', () => {
    const codec = createRichMarkdownEditorCodec(key)
    const first = '<details><summary>First</summary>\n\nBody\n\n</details>'
    const second =
      '<details><summary>Second</summary>\n\n```html\n</details>\n```\n\nBody\n\n</details>'
    expect(encodeRawMarkdownHtmlForRichEditor(first, codec)).toBe(first)
    expect(encodeRawMarkdownHtmlForRichEditor(second, codec)).toBe(
      codec.transport.create('block-html', second)
    )
    expect(encodeRawMarkdownHtmlForRichEditor(first, codec)).toBe(first)
  })

  it('preserves fenced code before a non-editable sibling', () => {
    const codec = createRichMarkdownEditorCodec(key)
    const editable = '<details><summary>Editable</summary>\n\nBody\n\n</details>'
    const raw = '<details class="custom"><summary>Raw</summary>\n\nBody\n\n</details>'
    const prefix = '~~~html\n<details><summary>Code</summary></details>\n~~~\n\n'
    expect(encodeRawMarkdownHtmlForRichEditor(`${prefix}${editable}\n\n${raw}`, codec)).toBe(
      `${prefix}${editable}\n\n${codec.transport.create('block-html', raw)}`
    )
  })
})

it('encodes unfinished details blocks without rescanning every remaining opener', () => {
  const codec = createRichMarkdownEditorCodec(key)
  const count = 30_000
  const content = '<details>\n'.repeat(count)
  const encoded = runInNewContext(
    'encode(content, codec)',
    { encode: encodeRawMarkdownHtmlForRichEditor, content, codec },
    { timeout: 1500 }
  )
  expect(encoded).toBe(`${codec.transport.create('block-html', '<details>')}\n`.repeat(count))
})

it.each(['', '\n```html\n</details>\n```\n'])(
  'preserves a closed inner toggle under an unfinished outer toggle: %j',
  (fencedClose) => {
    const codec = createRichMarkdownEditorCodec(key)
    const inner = '<details><summary>Inner</summary>\n\nBody\n\n</details>'
    const content = `<details>\n${fencedClose}${inner}\n<DeTaIlS open>\n`
    expect(encodeRawMarkdownHtmlForRichEditor(content, codec)).toBe(
      `${codec.transport.create('block-html', '<details>')}\n${fencedClose}${inner}\n${codec.transport.create('block-html', '<DeTaIlS open>')}\n`
    )
  }
)

it('checks sibling details fences without visiting every fence for each sibling', () => {
  const codec = createRichMarkdownEditorCodec(key)
  const content = '<details><summary>Toggle</summary>Body</details>\n\n```text\ncode\n```\n'.repeat(
    40_000
  )
  const encoded = runInNewContext(
    'encode(content, codec)',
    { encode: encodeRawMarkdownHtmlForRichEditor, content, codec },
    { timeout: 1500 }
  )
  expect(encoded).toBe(content)
})

it('rechecks earlier fences after an unfinished outer details scan reaches the end', () => {
  const codec = createRichMarkdownEditorCodec(key)
  const inner =
    '<details><summary>Inner</summary>\n\n```html\n</details>\n```\n\nBody\n\n</details>'
  expect(encodeRawMarkdownHtmlForRichEditor(`<details>\n${inner}`, codec)).toBe(
    `${codec.transport.create('block-html', '<details>')}\n${codec.transport.create('block-html', inner)}`
  )
})

it('keeps document details queries independent of their order', () => {
  const inner =
    '<details><summary>Inner</summary>\n\n```html\n</details>\n```\n\nBody\n\n</details>'
  const content = `${inner}\n\n${inner}`
  const match = createDetailsMatcher(content)
  for (const start of [content.lastIndexOf('<details>'), 0, content.lastIndexOf('<details>')]) {
    expect(match(start)?.raw).toBe(inner)
  }
})

it('preserves standalone details matching with unordered supplied fence ranges', () => {
  const content =
    '<details><summary>Inner</summary>\n\n```html\n</details>\n```\n\nBody\n\n</details>'
  const firstClose = content.indexOf('</details>')
  const lastClose = content.lastIndexOf('</details>')
  expect(
    matchDetailsHtmlBlock(content, 0, [
      [lastClose, lastClose + 1],
      [firstClose, firstClose + 1]
    ])
  ).toBeNull()
})

it.each(['no-terminator', 'fenced-close', 'unclosed-tail'] as const)(
  'does not rescan overlapping malformed details openings: %s',
  (shape) => {
    const codec = createRichMarkdownEditorCodec(key)
    const count = 40_000
    const openings = '<details\n'.repeat(count)
    const tail =
      shape === 'no-terminator'
        ? ''
        : shape === 'fenced-close'
          ? '>\n```html\n</details>\n```\n'
          : `>\n${'<details>\n'.repeat(count)}`
    const expected =
      shape === 'no-terminator'
        ? openings
        : '<details\n'.repeat(count - 1) +
          codec.transport.create('inline-html', '<details\n>') +
          (shape === 'fenced-close'
            ? '\n```html\n</details>\n```\n'
            : `\n${`${codec.transport.create('block-html', '<details>')}\n`.repeat(count)}`)
    const encoded = runInNewContext(
      'encode(content, codec)',
      { encode: encodeRawMarkdownHtmlForRichEditor, content: openings + tail, codec },
      { timeout: 1500 }
    )
    expect(encoded).toBe(expected)
  }
)

it('preserves multiline details openings containing other opening prefixes', () => {
  const codec = createRichMarkdownEditorCodec(key)
  const content = '<details\n<details\n>\n</details>'
  expect(encodeRawMarkdownHtmlForRichEditor(content, codec)).toBe(
    codec.transport.create('block-html', content)
  )
})

it('restarts opening-end lookup when an earlier block follows an unterminated query', () => {
  const block = '<details><summary>First</summary>Body</details>'
  const content = `${block}\n\n<details\n`
  const match = createDetailsMatcher(content)
  expect(match(content.lastIndexOf('<details'))).toBeNull()
  expect(match(0)?.raw).toBe(block)
  expect(match(content.lastIndexOf('<details'))).toBeNull()
  expect(match(0)?.raw).toBe(block)
})

it.each(['<details\n', '</details\n'])(
  'does not rescan incomplete inner details prefixes: %j',
  (fragment) => {
    const codec = createRichMarkdownEditorCodec(key)
    const incomplete = fragment.repeat(40_000)
    const content = `<details>\n${incomplete}`
    const encoded = runInNewContext(
      'encode(content, codec)',
      { encode: encodeRawMarkdownHtmlForRichEditor, content, codec },
      { timeout: 1500 }
    )
    expect(encoded).toBe(`${codec.transport.create('block-html', '<details>')}\n${incomplete}`)
  }
)

it('checks nested sibling details fences without revisiting every fence per child', () => {
  const codec = createRichMarkdownEditorCodec(key)
  const children = '<details><summary>Inner</summary>Body</details>\n\n```text\ncode\n```\n'.repeat(
    40_000
  )
  const content = `<details><summary>Outer</summary>\n\n${children}\n</details>`
  const encoded = runInNewContext(
    'encode(content, codec)',
    { encode: encodeRawMarkdownHtmlForRichEditor, content, codec },
    { timeout: 1500 }
  )
  expect(encoded).toBe(content)
})
