// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { normalizeEmptyListItems } from './rich-markdown-normalize'
import { registerRichMarkdownBlockSource } from './rich-markdown-block-source'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

function openMarkdown(source: string, codec = createRichMarkdownEditorCodec()): Editor {
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  normalizeEmptyListItems(editor)
  registerRichMarkdownBlockSource(editor, codec, false)
  return editor
}

function roundTrip(source: string): string {
  const editor = openMarkdown(source)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

function taskTexts(editor: Editor): string[] {
  const tasks: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'taskItem') {
      tasks.push(node.firstChild?.textContent ?? '')
    }
  })
  return tasks
}

function appendAndSave(editor: Editor, source: string, needle: string): string {
  const refs = {
    originalSourceRef: { current: source },
    baseCanonicalRef: { current: editor.getMarkdown() },
    lastCommittedMarkdownRef: { current: source }
  }
  expect(commitRichMarkdownSerialization(editor, refs, roundTrip).markdown).toBe(source)
  let end = -1
  editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text?.includes(needle)) {
      end = position + node.nodeSize
    }
  })
  expect(end).toBeGreaterThan(0)
  editor.view.dispatch(editor.state.tr.insertText('!', end))
  const saved = commitRichMarkdownSerialization(editor, refs, roundTrip)
  expect(saved.didSerialize).toBe(true)
  return saved.markdown
}

const contexts = [
  (body: string) => body,
  (body: string) => `> ${body.replaceAll('\n', '\n> ')}`,
  (body: string) => `4. Parent\n   ${body.replaceAll('\n', '\n   ')}`
]
const splitMarkers = contexts.flatMap((wrap) =>
  [false, true].flatMap((realTask) =>
    ['\n', '\r\n'].map((newline) => ({
      source: wrap(`-\n  [x] Later\n- ${realTask ? '[x] Real' : 'plain'}`).replaceAll(
        '\n',
        newline
      ),
      realTask
    }))
  )
)

describe('list content on the line after its marker', () => {
  it.each(splitMarkers)(
    'keeps the split checkbox literal and editable in $source',
    ({ source, realTask }) => {
      const editor = openMarkdown(source)
      try {
        editor.state.doc.check()
        expect(taskTexts(editor)).toEqual(realTask ? ['Real'] : [])
        const saved = appendAndSave(editor, source, 'Later')
        expect(saved).toBe(source.replace('Later', 'Later!'))
        const reopened = openMarkdown(saved)
        try {
          reopened.state.doc.check()
          expect(taskTexts(reopened)).toEqual(realTask ? ['Real'] : [])
          expect(reopened.getJSON()).toEqual(editor.getJSON())
        } finally {
          reopened.destroy()
        }
      } finally {
        editor.destroy()
      }
    }
  )

  it.each([
    '**Later**',
    '`Later`',
    '[Later](https://example.com)',
    '[[Later]]',
    '<sub>Later</sub>',
    '![Later](image.png)',
    '&nbsp;',
    '[ ]',
    '**Later\n  continued**',
    '`Later\n  continued`'
  ])('retains the inline content in %s', (body) => {
    const source = `-\n  ${body}\n- plain`
    const editor = openMarkdown(source)
    const expected = openMarkdown(`- ${body}\n- plain`)
    try {
      editor.state.doc.check()
      expect(editor.getJSON()).toEqual(expected.getJSON())
      const saved = appendAndSave(editor, source, 'plain')
      expect(saved).toBe(source.replace('plain', 'plain!'))
      const reopened = openMarkdown(saved)
      try {
        reopened.state.doc.check()
        expect(reopened.getJSON()).toEqual(editor.getJSON())
      } finally {
        reopened.destroy()
      }
    } finally {
      expected.destroy()
      editor.destroy()
    }
  })

  it.each(['# Later', '```js\n  Later\n  ```', '- Later', '```js\n  code\n  ```\n  **Later**'])(
    'keeps an editable leading paragraph before %s',
    (body) => {
      const source = `-\n  ${body}\n- plain`
      const editor = openMarkdown(source)
      try {
        editor.state.doc.check()
        expect(editor.state.doc.firstChild?.firstChild?.firstChild?.type.name).toBe('paragraph')
        const saved = appendAndSave(editor, source, 'plain')
        expect(saved).toBe(source.replace('plain', 'plain!'))
        const reopened = openMarkdown(saved)
        try {
          reopened.state.doc.check()
          expect(reopened.getJSON()).toEqual(editor.getJSON())
        } finally {
          reopened.destroy()
        }
      } finally {
        editor.destroy()
      }
    }
  )

  it('normalizes nested list content without lexing its parents again', () => {
    const depth = 8
    const source = Array.from({ length: depth }, (_, index) => `${'  '.repeat(index)}-`)
      .concat(`${'  '.repeat(depth)}**Later**`)
      .join('\n')
    const codec = createRichMarkdownEditorCodec()
    const editor = openMarkdown('', codec)
    const blockTokens = vi.spyOn(codec.marked.Lexer.prototype, 'blockTokens')
    try {
      const document = editor.schema.nodeFromJSON(editor.markdown!.parse(source))
      document.check()
      expect(document.textContent).toBe('Later')
      expect(blockTokens).toHaveBeenCalledTimes(depth + 1)
    } finally {
      blockTokens.mockRestore()
      editor.destroy()
    }
  })
})
