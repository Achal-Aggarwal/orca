// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { CellSelection } from '@tiptap/pm/tables'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  findRichMarkdownSearchMatches,
  createRichMarkdownSearchPlugin,
  richMarkdownSearchPluginKey
} from './rich-markdown-search'
import {
  prepareRichMarkdownSearchReplacement,
  replaceRichMarkdownSearchMatches
} from './rich-markdown-search-replace'
import { richMarkdownAnnotationHighlightPluginKey } from './rich-markdown-annotation-highlight'

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors) {
    editor.destroy()
  }
  editors.length = 0
})
function createEditor(): Editor {
  const codec = createRichMarkdownEditorCodec('00000000000000000000000000000000')
  const editor = new Editor({
    extensions: createRichMarkdownExtensions({ codec }),
    content:
      '# xxxx\n\nA **xx**_xx_ and [xxxx](https://example.com).\n\n- xxxx\n  - xxxx\n\n> xxxx\n\n| first | second |\n| --- | --- |\n| xxxx | xxxx |\n\n```ts\nconst xxxx = "xxxx"\n```\n\n[[Guide]] and xxxx\n',
    contentType: 'markdown'
  })
  editor.registerPlugin(createRichMarkdownSearchPlugin())
  const matches = findRichMarkdownSearchMatches(editor.state.doc, 'x')
  editor.view.dispatch(
    editor.state.tr
      .setMeta(richMarkdownSearchPluginKey, {
        query: 'x',
        matches,
        activeIndex: 1,
        matchCase: false,
        wholeWord: false
      })
      .setMeta(richMarkdownAnnotationHighlightPluginKey, {
        activeRange: matches[0],
        noteRanges: [matches[2], matches[5]]
      })
  )
  editors.push(editor)
  return editor
}
function native(editor: Editor, query: string, replacement: string): Transaction {
  const matches = findRichMarkdownSearchMatches(editor.state.doc, query)
  const tr = editor.state.tr
  for (let index = matches.length - 1; index >= 0; index--) {
    if (replacement) {
      tr.insertText(replacement, matches[index].from, matches[index].to)
    } else {
      tr.delete(matches[index].from, matches[index].to)
    }
  }
  return tr
}
function snapshot(editor: Editor) {
  return {
    json: editor.getJSON(),
    markdown: editor.getMarkdown(),
    html: editor.getHTML(),
    rendered: editor.view.dom.innerHTML,
    selection: editor.state.selection.toJSON(),
    search: richMarkdownSearchPluginKey
      .getState(editor.state)
      ?.decorations.find()
      .map((d) => [d.from, d.to, d.spec]),
    annotations: richMarkdownAnnotationHighlightPluginKey
      .getState(editor.state)
      ?.decorations.find()
      .map((d) => [d.from, d.to, d.spec])
  }
}
function compare(nativeEditor: Editor, candidate: Editor): void {
  expect(snapshot(candidate)).toEqual(snapshot(nativeEditor))
}
it.each(['replacement', '', 'x', '🙂', '[[New]]', 'https://a.test/ ', 'é\nnext'])(
  'preserves production extension rendering and history for %j',
  (replacement) => {
    const baseline = createEditor()
    const candidate = createEditor()
    for (const editor of [baseline, candidate]) {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 5))
      )
    }
    compare(baseline, candidate)
    const a = native(baseline, 'x', replacement)
    const b = prepareRichMarkdownSearchReplacement(
      candidate.state,
      findRichMarkdownSearchMatches(candidate.state.doc, 'x'),
      replacement
    )
    expect(b.steps.map((step) => step.toJSON())).toEqual(a.steps.map((step) => step.toJSON()))
    expect(b.docs.map((doc) => doc.toJSON())).toEqual(a.docs.map((doc) => doc.toJSON()))
    baseline.view.dispatch(a)
    candidate.view.dispatch(b)
    compare(baseline, candidate)
    for (const editor of [baseline, candidate]) {
      editor.view.dispatch(
        editor.state.tr
          .split(1 + Math.floor(editor.state.doc.child(0).content.size / 2))
          .setMeta('addToHistory', false)
      )
    }
    compare(baseline, candidate)
    for (const command of ['undo', 'redo', 'undo', 'redo'] as const) {
      expect(candidate.commands[command]()).toBe(baseline.commands[command]())
      compare(baseline, candidate)
    }
  }
)
it('preserves cell selections and table plugin normalization', () => {
  const baseline = createEditor()
  const candidate = createEditor()
  for (const editor of [baseline, candidate]) {
    const cells: number[] = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') {
        cells.push(pos)
      }
    })
    editor.view.dispatch(
      editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0], cells[1]))
    )
  }
  baseline.view.dispatch(native(baseline, 'x', 'long'))
  candidate.view.dispatch(
    prepareRichMarkdownSearchReplacement(
      candidate.state,
      findRichMarkdownSearchMatches(candidate.state.doc, 'x'),
      'long'
    )
  )
  compare(baseline, candidate)
  expect(candidate.commands.undo()).toBe(baseline.commands.undo())
  compare(baseline, candidate)
})

it('admits a wide document with production plugins at the measured array budget', () => {
  const baseline = createEditor()
  const candidate = createEditor()
  for (const editor of [baseline, candidate]) {
    const paragraphs = Array.from({ length: 500 }, () =>
      editor.schema.nodes.paragraph.create(null, editor.schema.text('xxxx'))
    )
    editor.view.dispatch(
      editor.state.tr
        .insert(editor.state.doc.content.size, paragraphs)
        .setMeta('addToHistory', false)
    )
  }
  const expected = native(baseline, 'x', 'y')
  const actual = replaceRichMarkdownSearchMatches(
    candidate.state,
    findRichMarkdownSearchMatches(candidate.state.doc, 'x'),
    'y'
  )
  expect(actual.steps.some((step) => step.constructor.name !== 'ReplaceStep')).toBe(true)
  expect(actual.steps.map((step) => step.toJSON())).toEqual(
    expected.steps.map((step) => step.toJSON())
  )
  baseline.view.dispatch(expected)
  candidate.view.dispatch(actual)
  compare(baseline, candidate)
  expect(candidate.commands.undo()).toBe(baseline.commands.undo())
  compare(baseline, candidate)
  expect(candidate.commands.redo()).toBe(baseline.commands.redo())
  compare(baseline, candidate)
})
