import { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import {
  AllSelection,
  EditorState,
  NodeSelection,
  TextSelection,
  type Transaction
} from '@tiptap/pm/state'
import { history, redo, undo } from '@tiptap/pm/history'
import { ReplaceStep, Step } from '@tiptap/pm/transform'
import { afterEach, expect, it, vi } from 'vitest'
import { findRichMarkdownSearchMatches } from './rich-markdown-search'
import {
  prepareRichMarkdownSearchReplacement,
  replaceRichMarkdownSearchMatches
} from './rich-markdown-search-replace'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 2 } } },
    code_block: { content: 'text*', marks: '', group: 'block', code: true },
    blockquote: { content: 'block+', group: 'block' },
    text: { group: 'inline' }
  },
  marks: {
    strong: {},
    em: {},
    link: { attrs: { href: {} }, inclusive: false }
  }
})

afterEach(() => vi.restoreAllMocks())

function replaceNormally(state: EditorState, text: string): Transaction {
  const matches = findRichMarkdownSearchMatches(state.doc, 'x')
  const transaction = state.tr
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]
    if (text) {
      transaction.insertText(text, match.from, match.to)
    } else {
      transaction.delete(match.from, match.to)
    }
  }
  return transaction
}

function stateJSON(state: EditorState) {
  return { doc: state.doc.toJSON(), selection: state.selection.toJSON(), marks: state.storedMarks }
}

function compareMappings(expected: Transaction, actual: Transaction): void {
  for (let position = 0; position <= expected.before.content.size; position += 1) {
    for (const assoc of [-1, 1]) {
      expect(actual.mapping.mapResult(position, assoc)).toEqual(
        expected.mapping.mapResult(position, assoc)
      )
      expect(actual.mapping.invert().mapResult(position, assoc)).toEqual(
        expected.mapping.invert().mapResult(position, assoc)
      )
    }
  }
}

it.each([500, 1_000])('copies one document root for %i matched paragraphs', (count) => {
  const doc = schema.node(
    'doc',
    null,
    Array.from({ length: count }, () => schema.node('paragraph', null, schema.text('xxxx')))
  )
  const initial = EditorState.create({ doc, plugins: [history()] })
  const matches = findRichMarkdownSearchMatches(doc, 'x')
  const originalCopy = ProseMirrorNode.prototype.copy
  let rootCopies = 0
  const copy = vi.spyOn(ProseMirrorNode.prototype, 'copy').mockImplementation(function (
    this: ProseMirrorNode,
    content
  ) {
    const result = originalCopy.call(this, content)
    if (this.type === schema.topNodeType && result !== this) {
      rootCopies += 1
    }
    return result
  })
  const transaction = replaceRichMarkdownSearchMatches(initial, matches, 'replacement')
  const result = initial.apply(transaction)
  copy.mockRestore()
  expect(transaction.steps).toHaveLength(count * 4)
  expect(transaction.steps.every((step) => step instanceof ReplaceStep)).toBe(true)
  expect(result.doc.textContent).toBe('replacement'.repeat(count * 4))
  expect(rootCopies).toBe(1)
})

it.each(['replacement', '', 'x', '🙂', 'x x'])(
  'preserves every native step, document, selection and history operation for %j',
  (replacement) => {
    const marked = [
      schema.text('x', [schema.marks.link.create({ href: '/a' })]),
      schema.text('x', [schema.marks.strong.create()]),
      schema.text(' x', [schema.marks.em.create()]),
      schema.text(' x')
    ]
    const doc = schema.node('doc', null, [
      schema.node('heading', null, marked),
      schema.node('blockquote', null, [schema.node('paragraph', null, marked)]),
      schema.node('code_block', null, schema.text('x xx x xxx x')),
      schema.node('paragraph', null, schema.text('tail'))
    ])
    for (const selection of [
      TextSelection.create(doc, 1),
      TextSelection.create(doc, 1, 5),
      TextSelection.create(doc, 5, 1),
      TextSelection.create(doc, doc.content.size - 1),
      NodeSelection.create(doc, 0),
      new AllSelection(doc)
    ]) {
      const initial = EditorState.create({
        doc,
        selection,
        storedMarks: [schema.marks.strong.create()],
        plugins: [history()]
      })
      const expected = replaceNormally(initial, replacement)
      const actual = prepareRichMarkdownSearchReplacement(
        initial,
        findRichMarkdownSearchMatches(doc, 'x'),
        replacement
      )
      expect(actual.steps.map((step) => step.toJSON())).toEqual(
        expected.steps.map((step) => step.toJSON())
      )
      expect(actual.docs.map((snapshot) => snapshot.toJSON())).toEqual(
        expected.docs.map((snapshot) => snapshot.toJSON())
      )
      expect(actual.selection.toJSON()).toEqual(expected.selection.toJSON())
      expect(actual.selectionSet).toBe(expected.selectionSet)
      expect(actual.storedMarksSet).toBe(expected.storedMarksSet)
      compareMappings(expected, actual)
      for (let index = 0; index < actual.steps.length; index += 1) {
        const step = actual.steps[index]
        const decoded = Step.fromJSON(schema, step.toJSON())
        expect(decoded.apply(actual.docs[index]).doc?.toJSON()).toEqual(
          expected.steps[index].apply(expected.docs[index]).doc?.toJSON()
        )
        expect(Object.getOwnPropertyDescriptor(actual.docs[index], 'content')?.value).toEqual(
          expected.docs[index].content
        )
      }
      let expectedState = initial.apply(expected)
      let actualState = initial.apply(actual)
      const insert = (state: EditorState) =>
        state.apply(state.tr.insertText('Z', 2).setMeta('addToHistory', false))
      expectedState = insert(expectedState)
      actualState = insert(actualState)
      for (const command of [undo, redo, undo, redo]) {
        expect(
          command(actualState, (transaction) => {
            actualState = actualState.apply(transaction)
          })
        ).toBe(
          command(expectedState, (transaction) => {
            expectedState = expectedState.apply(transaction)
          })
        )
        expect(stateJSON(actualState)).toEqual(stateJSON(expectedState))
      }
    }
  }
)

it.each([
  [100, 4],
  [250, 4],
  [500, 1],
  [1, 1_000]
])(
  'retains the native path below the measured array budget (%i paragraphs, %i matches each)',
  (count, matchesPerParagraph) => {
    const doc = schema.node(
      'doc',
      null,
      Array.from({ length: count }, () =>
        schema.node('paragraph', null, schema.text('x'.repeat(matchesPerParagraph)))
      )
    )
    const state = EditorState.create({ doc })
    const actual = replaceRichMarkdownSearchMatches(
      state,
      findRichMarkdownSearchMatches(doc, 'x'),
      'replacement'
    )
    const expected = replaceNormally(state, 'replacement')
    expect(actual.steps.every((step) => step.constructor === ReplaceStep)).toBe(true)
    expect(actual.steps.map((step) => step.toJSON())).toEqual(
      expected.steps.map((step) => step.toJSON())
    )
    expect(actual.doc.toJSON()).toEqual(expected.doc.toJSON())
  }
)
