import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { ReplaceStep, StepResult } from '@tiptap/pm/transform'

type ReplacementRange = { from: number; to: number }
type ReplacementRecord = { step: ReplaceStep; inverse: ReplaceStep }
type ReplacementParent = {
  node: ProseMirrorNode
  start: number
  ranges: ReplacementRange[]
  startIndex: number
  steps: ReplaceStep[]
  versions: WeakRef<ProseMirrorNode>[]
  finalNode: ProseMirrorNode
}

class PreparedTextReplacementStep extends ReplaceStep {
  constructor(
    step: ReplaceStep,
    private readonly beforeDocument: ProseMirrorNode,
    private readonly afterDocument: ProseMirrorNode,
    private readonly inverseStep: ReplaceStep
  ) {
    super(step.from, step.to, step.slice)
  }

  apply(doc: ProseMirrorNode): StepResult {
    return doc === this.beforeDocument ? StepResult.ok(this.afterDocument) : super.apply(doc)
  }

  invert(doc: ProseMirrorNode): ReplaceStep {
    return doc === this.beforeDocument ? this.inverseStep : super.invert(doc)
  }
}

function replaceNormally(
  state: EditorState,
  ranges: readonly ReplacementRange[],
  text: string
): Transaction {
  const transaction = state.tr
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]
    if (text) {
      transaction.insertText(text, range.from, range.to)
    } else {
      transaction.delete(range.from, range.to)
    }
  }
  return transaction
}

function findReplacementParents(
  doc: ProseMirrorNode,
  ranges: readonly ReplacementRange[]
): ReplacementParent[] | null {
  const parents: ReplacementParent[] = []
  let rangeIndex = 0
  function visit(node: ProseMirrorNode, start: number): void {
    if (rangeIndex === ranges.length) {
      return
    }
    if (node.inlineContent) {
      const local: ReplacementRange[] = []
      while (rangeIndex < ranges.length && ranges[rangeIndex].from <= start + node.content.size) {
        const range = ranges[rangeIndex]
        if (range.from < start || range.to > start + node.content.size) {
          return
        }
        local.push(range)
        rangeIndex += 1
      }
      if (local.length > 0) {
        parents.push({
          node,
          start,
          ranges: local,
          startIndex: 0,
          steps: [],
          versions: [],
          finalNode: node
        })
      }
      return
    }
    node.forEach((child, offset) => {
      const childStart = start + offset
      if (
        rangeIndex < ranges.length &&
        ranges[rangeIndex].from <= childStart + child.nodeSize &&
        !child.isLeaf
      ) {
        visit(child, childStart + 1)
      }
    })
  }
  visit(doc, 0)
  return rangeIndex === ranges.length ? parents : null
}

function parentAtReplacement(parent: ReplacementParent, snapshotIndex: number): ProseMirrorNode {
  const version = Math.max(0, Math.min(snapshotIndex - parent.startIndex, parent.steps.length))
  if (version === 0) {
    return parent.node
  }
  if (version === parent.steps.length) {
    return parent.finalNode
  }
  const retained = parent.versions[version - 1]?.deref()
  if (retained) {
    return retained
  }
  let node = parent.node
  for (let index = 0; index < version; index += 1) {
    const result = parent.steps[index].apply(node)
    if (!result.doc) {
      throw new Error(result.failed ?? 'Could not reconstruct a replacement snapshot')
    }
    node = result.doc
  }
  parent.versions[version - 1] = new WeakRef(node)
  return node
}

function replacementDocument(
  doc: ProseMirrorNode,
  parents: readonly ReplacementParent[],
  snapshotIndex: number
): ProseMirrorNode {
  let parentIndex = 0
  function visit(node: ProseMirrorNode, start: number): ProseMirrorNode {
    const parent = parents[parentIndex]
    if (!parent) {
      return node
    }
    if (parent.start === start && parent.node === node) {
      parentIndex += 1
      return parentAtReplacement(parent, snapshotIndex)
    }
    let changed = false
    const children: ProseMirrorNode[] = []
    node.forEach((child, offset) => {
      const childStart = start + offset
      const nextParent = parents[parentIndex]
      const next =
        nextParent &&
        nextParent.start >= childStart &&
        nextParent.start < childStart + child.nodeSize &&
        !child.isLeaf
          ? visit(child, childStart + 1)
          : child
      changed ||= next !== child
      children.push(next)
    })
    return changed ? node.copy(Fragment.fromArray(children)) : node
  }
  return visit(doc, 0)
}

function replacementSnapshots(
  doc: ProseMirrorNode,
  parents: readonly ReplacementParent[],
  count: number
): ProseMirrorNode[] {
  const snapshots = [doc]
  for (let index = 1; index < count; index += 1) {
    let retained: WeakRef<ProseMirrorNode> | undefined
    const materialize = (): ProseMirrorNode => {
      let node = retained?.deref()
      if (!node) {
        node = replacementDocument(doc, parents, index)
        retained = new WeakRef(node)
      }
      return node
    }
    // Native steps and plugins can inspect any snapshot without eagerly retaining every root array.
    snapshots.push(
      new Proxy(doc, {
        get(target, property, receiver) {
          if (property === 'content') {
            return materialize().content
          }
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Forward Node accessors with the snapshot proxy receiver.
          return Reflect.get(target, property, receiver)
        },
        getOwnPropertyDescriptor(target, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
          return property === 'content' && descriptor
            ? { ...descriptor, value: materialize().content }
            : descriptor
        }
      })
    )
  }
  snapshots.push(replacementDocument(doc, parents, count))
  return snapshots
}

export function prepareRichMarkdownSearchReplacement(
  state: EditorState,
  ranges: readonly ReplacementRange[],
  text: string
): Transaction {
  if (ranges.length < 2) {
    return replaceNormally(state, ranges, text)
  }
  const parents = findReplacementParents(state.doc, ranges)
  if (!parents) {
    return replaceNormally(state, ranges, text)
  }
  const records: ReplacementRecord[] = []
  for (let parentIndex = parents.length - 1; parentIndex >= 0; parentIndex -= 1) {
    const parent = parents[parentIndex]
    parent.startIndex = records.length
    let node = parent.node
    const local = EditorState.create({ doc: node }).tr
    if (records.length === 0 && state.storedMarks) {
      local.setStoredMarks(state.storedMarks)
    }
    for (let index = parent.ranges.length - 1; index >= 0; index -= 1) {
      const range = parent.ranges[index]
      const stepIndex = local.steps.length
      if (text) {
        local.insertText(text, range.from - parent.start, range.to - parent.start)
      } else {
        local.delete(range.from - parent.start, range.to - parent.start)
      }
      const step = local.steps[stepIndex]
      if (
        local.steps.length !== stepIndex + 1 ||
        !(step instanceof ReplaceStep) ||
        step.slice.openStart !== 0 ||
        step.slice.openEnd !== 0
      ) {
        return replaceNormally(state, ranges, text)
      }
      const from = step.from + parent.start
      records.push({
        step: new ReplaceStep(from, step.to + parent.start, step.slice),
        inverse: new ReplaceStep(
          from,
          from + step.slice.size,
          parent.node.slice(step.from, step.to)
        )
      })
      node = local.doc
      parent.steps.push(step)
      parent.versions.push(new WeakRef(node))
    }
    parent.finalNode = node
  }
  const snapshots = replacementSnapshots(state.doc, parents, records.length)
  const transaction = state.tr
  const isTextSelection = state.selection instanceof TextSelection
  let anchor = state.selection.anchor
  let head = state.selection.head
  let collapsedSelection = false
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    transaction.step(
      new PreparedTextReplacementStep(
        record.step,
        snapshots[index],
        snapshots[index + 1],
        record.inverse
      )
    )
    if (isTextSelection) {
      const map = record.step.getMap()
      anchor = map.map(anchor, 1)
      head = map.map(head, 1)
      if (text && anchor !== head && Math.max(anchor, head) === record.step.from + text.length) {
        anchor = head = Math.max(anchor, head)
        collapsedSelection = true
      }
    }
  }
  if (collapsedSelection) {
    transaction.setSelection(TextSelection.create(transaction.doc, anchor, head))
  }
  return transaction
}

export function replaceRichMarkdownSearchMatches(
  state: EditorState,
  ranges: readonly ReplacementRange[],
  text: string
): Transaction {
  // Preparation pays off once native snapshots would retain a million document child slots.
  if (state.doc.childCount * ranges.length < 1_000_000) {
    return replaceNormally(state, ranges, text)
  }
  return prepareRichMarkdownSearchReplacement(state, ranges, text)
}
