import { getChangedRanges, type ChangedRange } from '@tiptap/core'
import { ReplaceStep, StepMap, type Transform } from '@tiptap/pm/transform'

export function getRichMarkdownChangedRanges(transform: Transform): ChangedRange[] {
  const { steps, mapping } = transform
  if (
    steps.length < 2 ||
    mapping.maps.length !== steps.length ||
    mapping.from !== 0 ||
    mapping.to !== mapping.maps.length
  ) {
    return getChangedRanges(transform)
  }
  const replacements: ReplaceStep[] = []
  let previousFrom = Infinity
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (
      !(step instanceof ReplaceStep) ||
      step.to > previousFrom ||
      mapping.getMirror(index) !== undefined
    ) {
      return getChangedRanges(transform)
    }
    const stepMap = mapping.maps[index]
    if (
      Object.getPrototypeOf(stepMap) !== StepMap.prototype ||
      stepMap.map !== StepMap.prototype.map ||
      stepMap.mapResult !== StepMap.prototype.mapResult ||
      stepMap.forEach !== StepMap.prototype.forEach ||
      stepMap.invert !== StepMap.prototype.invert
    ) {
      return getChangedRanges(transform)
    }
    let rangeCount = 0
    let matchesStep = true
    stepMap.forEach((from, to, newFrom, newTo) => {
      rangeCount += 1
      matchesStep &&=
        from === step.from &&
        to === step.to &&
        newFrom === step.from &&
        newTo === step.from + step.slice.size
    })
    if (rangeCount !== 1 || !matchesStep) {
      return getChangedRanges(transform)
    }
    replacements.push(step)
    previousFrom = step.from
  }
  // Descending disjoint edits share source offsets; adjacent edits form one affected union.
  const changes: ChangedRange[] = []
  let offset = 0
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const step = replacements[index]
    const from = step.from + offset
    const to = from + step.slice.size
    const previous = changes.at(-1)
    if (previous && previous.oldRange.to === step.from) {
      previous.oldRange.to = step.to
      previous.newRange.to = to
    } else {
      changes.push({ oldRange: { from: step.from, to: step.to }, newRange: { from, to } })
    }
    offset += step.slice.size - (step.to - step.from)
  }
  return changes
}
