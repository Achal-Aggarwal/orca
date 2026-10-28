import { getChangedRanges, type ChangedRange } from '@tiptap/core'
import { Schema, Slice } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { Mapping, ReplaceStep, StepMap } from '@tiptap/pm/transform'
import { expect, it } from 'vitest'
import { getRichMarkdownChangedRanges } from './rich-markdown-changed-ranges'

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
  marks: { strong: {} }
})
const doc = schema.node(
  'doc',
  null,
  Array.from({ length: 8 }, () => schema.node('paragraph', null, schema.text('abcdefgh'.repeat(5))))
)
function union(changes: ChangedRange[], field: 'oldRange' | 'newRange') {
  const ranges = changes
    .map((change) => ({ ...change[field] }))
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const result: { from: number; to: number }[] = []
  for (const range of ranges) {
    const previous = result.at(-1)
    if (previous && previous.to >= range.from) {
      previous.to = Math.max(previous.to, range.to)
    } else {
      result.push(range)
    }
  }
  return result
}
it.each([100, 1_000])(
  'projects %i sparse descending replacements without mapping or inversion work',
  (count) => {
    const many = schema.node(
      'doc',
      null,
      Array.from({ length: count }, () => schema.node('paragraph', null, schema.text('needle')))
    )
    const tr = EditorState.create({ doc: many }).tr
    for (let index = count - 1; index >= 0; index--) {
      tr.insertText('replacement', index * 8 + 1, index * 8 + 7)
    }
    const original = {
      map: StepMap.prototype.map,
      mapResult: StepMap.prototype.mapResult,
      invert: StepMap.prototype.invert,
      mappingInvert: Mapping.prototype.invert
    }
    const counts = { map: 0, mapResult: 0, invert: 0, mappingInvert: 0 }
    const changes = (() => {
      try {
        StepMap.prototype.map = function (pos, assoc) {
          counts.map += 1
          return original.map.call(this, pos, assoc)
        }
        StepMap.prototype.mapResult = function (pos, assoc) {
          counts.mapResult += 1
          return original.mapResult.call(this, pos, assoc)
        }
        StepMap.prototype.invert = function () {
          counts.invert += 1
          return original.invert.call(this)
        }
        Mapping.prototype.invert = function () {
          counts.mappingInvert += 1
          return original.mappingInvert.call(this)
        }
        return getRichMarkdownChangedRanges(tr)
      } finally {
        StepMap.prototype.map = original.map
        StepMap.prototype.mapResult = original.mapResult
        StepMap.prototype.invert = original.invert
        Mapping.prototype.invert = original.mappingInvert
      }
    })()
    expect(changes).toHaveLength(count)
    expect(counts).toEqual({ map: 0, mapResult: 0, invert: 0, mappingInvert: 0 })
    const expected = getChangedRanges(tr)
    expect(union(changes, 'oldRange')).toEqual(union(expected, 'oldRange'))
    expect(union(changes, 'newRange')).toEqual(union(expected, 'newRange'))
  }
)
it('preserves affected unions across adjacent edits, insertions, deletions and structural replacements', () => {
  let seed = 1
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    return seed % bound
  }
  for (let run = 0; run < 100; run++) {
    const ranges: { from: number; to: number; text: string }[] = []
    let pos = 1
    while (pos < doc.content.size - 2) {
      pos += random(10)
      if (pos > doc.content.size) {
        break
      }
      const resolved = doc.resolve(pos)
      if (!resolved.parent.inlineContent) {
        pos++
        continue
      }
      const size = Math.min(random(4), resolved.parent.content.size - resolved.parentOffset)
      ranges.push({ from: pos, to: pos + size, text: ['', 'x', 'long', '🙂'][random(4)] })
      pos += Math.max(size, 1)
    }
    const tr = EditorState.create({ doc }).tr
    for (const range of ranges.toReversed()) {
      if (range.text) {
        tr.insertText(range.text, range.from, range.to)
      } else {
        tr.delete(range.from, range.to)
      }
    }
    const expected = getChangedRanges(tr)
    const actual = getRichMarkdownChangedRanges(tr)
    for (const field of ['oldRange', 'newRange'] as const) {
      expect(union(actual, field)).toEqual(union(expected, field))
    }
  }
  const tr = EditorState.create({ doc })
    .tr.delete(42 * 5, 42 * 6)
    .delete(42, 84)
  for (const field of ['oldRange', 'newRange'] as const) {
    expect(union(getRichMarkdownChangedRanges(tr), field)).toEqual(
      union(getChangedRanges(tr), field)
    )
  }
})
it.each(['ascending', 'overlap', 'mark', 'attribute'] as const)(
  'keeps native projection for %s steps',
  (kind) => {
    const tr = EditorState.create({ doc }).tr
    if (kind === 'ascending') {
      tr.insertText('x', 1, 2).insertText('x', 43, 44)
    }
    if (kind === 'overlap') {
      tr.insertText('xxxx', 1, 4).delete(2, 4)
    }
    if (kind === 'mark') {
      tr.insertText('x', 43, 44).addMark(1, 3, schema.marks.strong.create())
    }
    if (kind === 'attribute') {
      tr.insertText('x', 43, 44).setDocAttribute('x', 'y')
    }
    expect(getRichMarkdownChangedRanges(tr)).toEqual(getChangedRanges(tr))
  }
)

it('delegates mirrored and extra-map transforms to native projection', () => {
  const mirrored = EditorState.create({ doc }).tr.insertText('x', 43, 44).insertText('y', 1, 2)
  Object.defineProperty(mirrored, 'mapping', { value: new Mapping(mirrored.mapping.maps, [0, 1]) })
  expect(getRichMarkdownChangedRanges(mirrored)).toEqual(getChangedRanges(mirrored))
  const extra = EditorState.create({ doc }).tr.insertText('x', 43, 44).insertText('y', 1, 2)
  extra.mapping.appendMap(new StepMap([0, 0, 1]))
  expect(getRichMarkdownChangedRanges(extra)).toEqual(getChangedRanges(extra))
})

it.each(['subclass', 'own-method'] as const)(
  'keeps native projection for custom %s map behavior',
  (kind) => {
    class ShiftedMap extends StepMap {
      map(pos: number, assoc?: number): number {
        return super.map(pos, assoc) + 1
      }
    }
    class CustomReplacement extends ReplaceStep {
      getMap(): StepMap {
        const ranges = [this.from, this.to - this.from, this.slice.size]
        if (kind === 'subclass') {
          return new ShiftedMap(ranges)
        }
        const map = new StepMap(ranges)
        const nativeMap = map.map.bind(map)
        map.map = (pos, assoc) => nativeMap(pos, assoc) + 1
        return map
      }
    }
    const tr = EditorState.create({ doc }).tr
    const replacement = new Slice(schema.node('paragraph', null, schema.text('x')).content, 0, 0)
    tr.step(new CustomReplacement(43, 44, replacement))
    tr.step(new CustomReplacement(1, 2, replacement))
    expect(getRichMarkdownChangedRanges(tr)).toEqual(getChangedRanges(tr))
  }
)
