import { getRichMarkdownChangedRanges } from './rich-markdown-changed-ranges'
import type { Node as DocumentNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { parseMarkdownDocLink } from './markdown-doc-links'
import { canHoldDocLink, DOC_LINK_PATTERN } from './rich-markdown-doc-link-scan'
import { isDocLinkResolved, type DocLinkStorage } from './rich-markdown-doc-link-storage'
import { isReservedRichMarkdownTransportBody } from './rich-markdown-source-transport'

type DocLinkIndex = {
  atoms: DecorationSet
  text: DecorationSet
  preview: DecorationSet
}

type DocumentRange = { from: number; to: number }

const docLinkInlinePreviewKey = new PluginKey<DocLinkIndex>('docLinkInlinePreview')

function atomDecoration(
  from: number,
  to: number,
  target: string,
  storage: DocLinkStorage
): Decoration {
  return Decoration.node(
    from,
    to,
    { 'data-doc-link-resolved': String(isDocLinkResolved(target, storage)) },
    { target }
  )
}

function textDecoration(
  from: number,
  to: number,
  target: string,
  label: string | null,
  storage: DocLinkStorage
): Decoration {
  const className = isDocLinkResolved(target, storage)
    ? 'rich-markdown-doc-link-preview'
    : 'rich-markdown-doc-link-preview rich-markdown-doc-link-preview--missing'
  return Decoration.inline(from, to, { class: className }, { target, label })
}

function scanDocLinks(
  doc: DocumentNode,
  ranges: DocumentRange[],
  storage: DocLinkStorage
): { atoms: Decoration[]; text: Decoration[] } {
  const atoms: Decoration[] = []
  const text: Decoration[] = []
  for (const range of ranges) {
    doc.nodesBetween(range.from, range.to, (node, pos, parent) => {
      if (node.type.name === 'markdownDocLink') {
        const target: unknown = node.attrs.target
        atoms.push(
          atomDecoration(
            pos,
            pos + node.nodeSize,
            typeof target === 'string' ? target : '',
            storage
          )
        )
        return false
      }
      if (!canHoldDocLink(node, parent)) {
        return true
      }
      for (const match of node.text.matchAll(DOC_LINK_PATTERN)) {
        const link = isReservedRichMarkdownTransportBody(match[1])
          ? null
          : parseMarkdownDocLink(match[1])
        if (link && match.index !== undefined) {
          const from = pos + match.index
          text.push(textDecoration(from, from + match[0].length, link.target, link.alias, storage))
        }
      }
      return false
    })
  }
  return { atoms, text }
}

function changedTextblockRanges(transaction: Transaction): DocumentRange[] {
  const doc = transaction.doc
  const hasUnlocalizedStep = transaction.steps.some((step, index) => {
    let hasMappedRange = false
    transaction.mapping.maps[index].forEach(() => {
      hasMappedRange = true
    })
    return (
      !hasMappedRange &&
      (!('from' in step) ||
        typeof step.from !== 'number' ||
        !('to' in step) ||
        typeof step.to !== 'number')
    )
  })
  const changes = getRichMarkdownChangedRanges(transaction)
  if (hasUnlocalizedStep || changes.length === 0) {
    // Unlocalized steps need a full rescan even when another step provides a range.
    return [{ from: 0, to: doc.content.size }]
  }
  const ranges = changes.map(({ newRange }) => {
    // Deletions and mark changes can join text nodes across the changed span.
    let from = Math.max(0, newRange.from - 1)
    let to = Math.min(doc.content.size, newRange.to + 1)
    for (const position of [from, to]) {
      const resolved = doc.resolve(position)
      for (let depth = resolved.depth; depth > 0; depth -= 1) {
        if (resolved.node(depth).isTextblock) {
          from = Math.min(from, resolved.before(depth))
          to = Math.max(to, resolved.after(depth))
          break
        }
      }
    }
    return { from, to }
  })
  ranges.sort((left, right) => left.from - right.from)
  const merged: DocumentRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to)
    } else {
      merged.push(range)
    }
  }
  return merged
}

function updateIndexedDecorations(
  decorations: DecorationSet,
  transaction: Transaction,
  ranges: DocumentRange[],
  additions: Decoration[]
): DecorationSet {
  const onlyRange = ranges.length === 1 ? ranges[0] : undefined
  if (onlyRange && onlyRange.from === 0 && onlyRange.to === transaction.doc.content.size) {
    return DecorationSet.create(transaction.doc, additions)
  }
  let mapped = decorations.map(transaction.mapping, transaction.doc)
  for (const range of ranges) {
    const stale = mapped
      .find(range.from, range.to)
      .filter((decoration) => decoration.from < range.to && decoration.to > range.from)
    mapped = mapped.remove(stale)
  }
  return mapped.add(transaction.doc, additions)
}

function cursorPreview(
  state: EditorState,
  atoms: DecorationSet,
  text: DecorationSet
): DecorationSet {
  const cursor = state.selection.from
  const active = text
    .find(cursor, cursor)
    .filter((decoration) => cursor > decoration.from && cursor <= decoration.to)
  return atoms.add(state.doc, active)
}

export function findPendingDocLinkConversions(state: EditorState): {
  from: number
  to: number
  target: string
  label: string | null
}[] {
  const candidates = docLinkInlinePreviewKey.getState(state)?.text.find() ?? []
  return candidates.flatMap((candidate) => {
    const target: unknown = candidate.spec.target
    const label: unknown = candidate.spec.label
    return typeof target === 'string'
      ? [
          {
            from: candidate.from,
            to: candidate.to,
            target,
            label: typeof label === 'string' ? label : null
          }
        ]
      : []
  })
}

export function createDocLinkPreviewPlugin(storage: DocLinkStorage): Plugin<DocLinkIndex> {
  return new Plugin<DocLinkIndex>({
    key: docLinkInlinePreviewKey,
    state: {
      init(_, state) {
        const scanned = scanDocLinks(state.doc, [{ from: 0, to: state.doc.content.size }], storage)
        const atoms = DecorationSet.create(state.doc, scanned.atoms)
        const text = DecorationSet.create(state.doc, scanned.text)
        return { atoms, text, preview: cursorPreview(state, atoms, text) }
      },
      apply(transaction, previous, oldState, newState) {
        const selectionMoved = !oldState.selection.eq(newState.selection)
        const resolutionChanged = transaction.getMeta('docLinksUpdated')
        if (!transaction.docChanged && !selectionMoved && !resolutionChanged) {
          return previous
        }
        let { atoms, text } = previous
        if (transaction.docChanged) {
          const ranges = changedTextblockRanges(transaction)
          const scanned = scanDocLinks(newState.doc, ranges, storage)
          atoms = updateIndexedDecorations(atoms, transaction, ranges, scanned.atoms)
          text = updateIndexedDecorations(text, transaction, ranges, scanned.text)
        }
        if (resolutionChanged) {
          atoms = DecorationSet.create(
            newState.doc,
            atoms.find().map((decoration) => {
              const target: unknown = decoration.spec.target
              return atomDecoration(
                decoration.from,
                decoration.to,
                typeof target === 'string' ? target : '',
                storage
              )
            })
          )
          text = DecorationSet.create(
            newState.doc,
            text.find().map((decoration) => {
              const target: unknown = decoration.spec.target
              const label: unknown = decoration.spec.label
              return textDecoration(
                decoration.from,
                decoration.to,
                typeof target === 'string' ? target : '',
                typeof label === 'string' ? label : null,
                storage
              )
            })
          )
        }
        return { atoms, text, preview: cursorPreview(newState, atoms, text) }
      }
    },
    props: {
      decorations: (state) => docLinkInlinePreviewKey.getState(state)?.preview
    }
  })
}
