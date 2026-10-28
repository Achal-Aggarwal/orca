// @vitest-environment happy-dom

import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMarkdownDocLink } from './rich-markdown-doc-link'
import * as docLinkScan from './rich-markdown-doc-link-scan'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const editors: Editor[] = []

function paragraph(text: string, code = false): JSONContent {
  return { type: code ? 'codeBlock' : 'paragraph', content: [{ type: 'text', text }] }
}

function createEditor(content: JSONContent[], cursor = 1): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      createMarkdownDocLink(createRichMarkdownEditorCodec().transport)
    ],
    content: { type: 'doc', content }
  })
  editor.commands.setTextSelection(cursor)
  editors.push(editor)
  return editor
}

function targets(editor: Editor): string[] {
  return [...editor.view.dom.querySelectorAll('[data-doc-link-target]')].map(
    (node) => node.getAttribute('data-doc-link-target') ?? ''
  )
}

function expectPreview(editor: Editor, text: string | null): void {
  expect(
    editor.view.dom.querySelector('.rich-markdown-doc-link-preview')?.textContent ?? null
  ).toBe(text)
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  vi.restoreAllMocks()
})

describe('incremental document links', () => {
  it.each([100, 1000])('limits scan work in a document with %i paragraphs', (count) => {
    const editor = createEditor(
      Array.from({ length: count }, (_, index) => paragraph(`paragraph ${index}`))
    )
    const scan = vi.spyOn(docLinkScan, 'canHoldDocLink')

    editor.view.dispatch(editor.state.tr.insertText('x', 2))
    expect(editor.state.doc.firstChild?.textContent).toBe('pxaragraph 0')
    expect(scan.mock.calls.length).toBeGreaterThan(0)
    expect(scan.mock.calls.length).toBeLessThanOrEqual(6)

    scan.mockClear()
    editor.commands.setTextSelection(4)
    expect(editor.state.selection.from).toBe(4)
    expect(scan).not.toHaveBeenCalled()

    scan.mockClear()
    editor.view.dispatch(editor.state.tr.setMeta('docLinksUpdated', true))
    expect(scan).not.toHaveBeenCalled()

    scan.mockClear()
    editor.view.dispatch(editor.state.tr.setMeta('unrelatedMetadata', true))
    expect(scan).not.toHaveBeenCalled()
  })

  it('converts initial links outside the cursor and keeps only its current link preview', () => {
    const editor = createEditor(
      [paragraph('[[Guide|Read guide]] and [[Other]]'), paragraph('[[Elsewhere]]')],
      4
    )

    expectPreview(editor, '[[Guide|Read guide]]')
    expect(targets(editor)).toEqual(['Other', 'Elsewhere'])
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    expectPreview(editor, null)
    expect(targets(editor)).toEqual(['Guide', 'Other', 'Elsewhere'])
    expect(editor.view.dom.querySelector('[data-doc-link-target="Guide"]')?.textContent).toBe(
      'Read guide'
    )
  })

  it('indexes completed syntax after edits and maps a pending alias through earlier edits', () => {
    const editor = createEditor([paragraph('prefix'), paragraph('[[Guide|Read guide]')])
    const end = editor.state.doc.content.size - 1
    const completion = editor.state.tr.insertText(']', end)
    completion.setSelection(TextSelection.create(completion.doc, end))
    editor.view.dispatch(completion)
    expectPreview(editor, '[[Guide|Read guide]]')

    const transaction = editor.state.tr.insertText('longer ', 1)
    editor.view.dispatch(transaction)
    expectPreview(editor, '[[Guide|Read guide]]')
    editor.commands.setTextSelection(1)
    expect(targets(editor)).toEqual(['Guide'])
    expect(editor.view.dom.querySelector('[data-doc-link-target="Guide"]')?.textContent).toBe(
      'Read guide'
    )
  })

  it('processes multiple changed ranges once and preserves both targets', () => {
    const editor = createEditor([paragraph('first'), paragraph('middle'), paragraph('last')])
    const scan = vi.spyOn(docLinkScan, 'canHoldDocLink')
    const last = editor.state.doc.content.size - 1
    const transaction = editor.state.tr.insertText(' [[Last]]', last).insertText('[[First]] ', 1)
    transaction.setSelection(TextSelection.create(transaction.doc, 1))
    editor.view.dispatch(transaction)

    expect(targets(editor)).toEqual(['First', 'Last'])
    expect(scan.mock.calls.length).toBeLessThanOrEqual(14)
    expect(editor.state.doc.child(1).textContent).toBe('middle')
  })

  it('updates candidates across mark changes and code-block conversions', () => {
    const editor = createEditor([paragraph('[[Guide]]')], 4)
    expectPreview(editor, '[[Guide]]')
    editor.view.dispatch(editor.state.tr.addMark(1, 10, editor.schema.marks.code.create()))
    expectPreview(editor, null)
    editor.commands.setTextSelection(1)
    expect(targets(editor)).toEqual([])
    editor.view.dispatch(editor.state.tr.removeMark(1, 10, editor.schema.marks.code))
    expect(targets(editor)).toEqual(['Guide'])

    const code = createEditor([paragraph('[[Code]]', true)], 4)
    expect(targets(code)).toEqual([])
    expectPreview(code, null)
    code.commands.setParagraph()
    expectPreview(code, '[[Code]]')
    code.commands.setTextSelection(1)
    expect(targets(code)).toEqual(['Code'])
  })

  it('keeps links split across marks literal until their text nodes join', () => {
    const editor = createEditor([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '[[Gui' },
          { type: 'text', text: 'de]]', marks: [{ type: 'bold' }] }
        ]
      }
    ])
    expect(targets(editor)).toEqual([])
    editor.view.dispatch(editor.state.tr.removeMark(1, 10, editor.schema.marks.bold))
    expect(targets(editor)).toEqual(['Guide'])
  })

  it('discovers links when paragraphs join and restores them through undo and redo', () => {
    const editor = createEditor([paragraph('[[Gui'), paragraph('de]]')])
    expect(targets(editor)).toEqual([])
    editor.view.dispatch(editor.state.tr.join(editor.state.doc.firstChild!.nodeSize))
    expect(targets(editor)).toEqual(['Guide'])
    expect(editor.commands.undo()).toBe(true)
    expect(targets(editor)).toEqual([])
    expect(editor.state.doc.childCount).toBe(2)
    expect(editor.commands.redo()).toBe(true)
    expect(targets(editor)).toEqual(['Guide'])
  })

  it('maps untouched atoms and refreshes directory resolution without scanning prose', () => {
    const editor = createEditor([
      paragraph('before'),
      {
        type: 'paragraph',
        content: [{ type: 'markdownDocLink', attrs: { target: 'Guide', label: 'Read guide' } }]
      }
    ])
    const scan = vi.spyOn(docLinkScan, 'canHoldDocLink')
    const storage = editor.storage.markdownDocLink
    if (!storage) {
      throw new Error('Missing document-link storage')
    }
    storage.documents = [
      { filePath: '/repo/Guide.md', relativePath: 'Guide.md', basename: 'Guide.md', name: 'Guide' }
    ]
    editor.view.dispatch(editor.state.tr.setMeta('docLinksUpdated', true))
    expect(scan).not.toHaveBeenCalled()
    expect(editor.view.dom.querySelector('.rich-markdown-doc-link--missing')).toBeNull()

    editor.view.dispatch(editor.state.tr.insertText('longer ', 1))
    expect(targets(editor)).toEqual(['Guide'])
    const before = editor.state.doc
    storage.documents = []
    scan.mockClear()
    editor.view.dispatch(editor.state.tr.setMeta('docLinksUpdated', true))
    expect(scan).not.toHaveBeenCalled()
    expect(editor.state.doc).toBe(before)
    expect(editor.view.dom.querySelector('.rich-markdown-doc-link--missing')?.textContent).toBe(
      'Read guide'
    )
  })

  it('rebuilds candidates after document replacement and unlocalized attribute steps', () => {
    const editor = createEditor([paragraph('[[Old]]')])
    const replacement = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [paragraph('[[New|Replacement]]'), paragraph('after')]
    })
    const transaction = editor.state.tr.replaceWith(
      0,
      editor.state.doc.content.size,
      replacement.content
    )
    transaction.setSelection(
      TextSelection.create(transaction.doc, transaction.doc.content.size - 1)
    )
    editor.view.dispatch(transaction)
    expect(targets(editor)).toEqual(['New'])

    editor.view.dispatch(editor.state.tr.setNodeAttribute(1, 'target', 'Changed'))
    expect(targets(editor)).toEqual(['Changed'])
    expect(editor.view.dom.querySelector('[data-doc-link-target="Changed"]')?.textContent).toBe(
      'Replacement'
    )
  })

  it.each(['before', 'after'])(
    'refreshes distant attribute edits %s localized text edits',
    (order) => {
      const editor = createEditor([
        paragraph('before'),
        paragraph('between'),
        {
          type: 'paragraph',
          content: [{ type: 'markdownDocLink', attrs: { target: 'Guide', label: 'Read guide' } }]
        }
      ])
      const targetPosition = editor.state.doc.content.size - 2
      const transaction = editor.state.tr
      if (order === 'before') {
        transaction.setNodeAttribute(targetPosition, 'target', 'Changed').insertText('prefix ', 1)
      } else {
        transaction.insertText('prefix ', 1)
        transaction.setNodeAttribute(transaction.mapping.map(targetPosition), 'target', 'Changed')
      }
      editor.view.dispatch(transaction)
      expect(targets(editor)).toEqual(['Changed'])
      const storage = editor.storage.markdownDocLink
      if (!storage) {
        throw new Error('Missing document-link storage')
      }
      storage.documents = [
        {
          filePath: '/repo/Changed.md',
          relativePath: 'Changed.md',
          basename: 'Changed.md',
          name: 'Changed'
        }
      ]
      editor.view.dispatch(editor.state.tr.setMeta('docLinksUpdated', true))
      expect(editor.view.dom.querySelector('.rich-markdown-doc-link--missing')).toBeNull()
      expect(editor.view.dom.querySelector('[data-doc-link-target="Changed"]')?.textContent).toBe(
        'Read guide'
      )
    }
  )
})
