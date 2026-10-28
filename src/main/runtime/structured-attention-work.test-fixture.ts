import { expect, vi } from 'vitest'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { StructuredAgentSessionTurnCompletionFeed } from '../native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import { countAttentionCollectionWork } from './attention-operation-count.test-fixture'

export function observeStructuredAttentionWork(journal: AgentSessionJournal) {
  type SnapshotCost = {
    phase: string
    items: number
    submissions: number
    materialization: number
    work: number
  }
  const snapshots: SnapshotCost[] = []
  let phase = 'baseline'
  const originalObserve = StructuredAgentSessionTurnCompletionFeed.prototype.observe
  vi.spyOn(StructuredAgentSessionTurnCompletionFeed.prototype, 'observe').mockImplementation(
    function (this: StructuredAgentSessionTurnCompletionFeed, ...args) {
      const previous = phase
      phase = 'new-root'
      try {
        return originalObserve.apply(this, args)
      } finally {
        phase = previous
      }
    }
  )
  const originalSnapshot = journal.snapshot
  vi.spyOn(journal, 'snapshot').mockImplementation(() => {
    const { result, counts } = countAttentionCollectionWork(originalSnapshot)
    const cost = {
      phase,
      items: result.items.length,
      submissions: result.submissions.length,
      materialization: counts.callbacks + counts.copies + counts.mapValues,
      work: counts.callbacks + counts.copies + counts.mapValues
    }
    snapshots.push(cost)
    const countSearch = <T>(values: T[]) => {
      const find = Array.prototype.find.bind(values)
      vi.spyOn(values, 'find').mockImplementation((predicate, thisArg) =>
        find((value, index, array) => {
          cost.work += 1
          return predicate.call(thisArg, value, index, array)
        })
      )
    }
    countSearch(result.items)
    countSearch(result.submissions)
    return result
  })
  return {
    snapshots,
    reset() {
      snapshots.length = 0
    }
  }
}

export function assertSnapshotCosts(
  costs: { items: number; submissions: number; materialization: number; work: number }[]
) {
  expect(costs.length).toBeGreaterThan(0)
  for (const cost of costs) {
    const { items: i, submissions: s } = cost
    if (cost.materialization > 0) {
      expect(cost.work).toBeGreaterThan(i + s)
    } else {
      expect(cost.work).toBeGreaterThan(0)
      expect(cost.work).toBeLessThanOrEqual(i + s)
    }
    expect(cost.work).toBeLessThanOrEqual(
      4 * (i + s) + 8 * (i * Math.ceil(Math.log2(i + 1)) + s * Math.ceil(Math.log2(s + 1)))
    )
  }
}
