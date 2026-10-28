import { useEffect, useMemo, useReducer } from 'react'
import {
  readStructuredAgentSessionItem,
  supportsStructuredAgentSessionItemDetail
} from '@/runtime/structured-agent-session-client'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Bounded stream copies are display-only heads; hydrate before offering expansion or Copy. */
export function useStructuredAgentStartItems(
  items: readonly AgentJournalRenderItem[],
  sessionId: string,
  target: RuntimeClientTarget
): readonly AgentJournalRenderItem[] {
  const reader = useMemo(
    () => ({
      reads: new WeakMap<AgentJournalRenderItem, Promise<void>>(),
      full: new WeakMap<AgentJournalRenderItem, AgentJournalRenderItem>()
    }),
    [sessionId, target]
  )
  const [revision, publish] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    let active = true
    const pending = items.filter(
      (item) => item.body.kind === 'agent-start' && item.shortened && !reader.full.has(item)
    )
    if (pending.length === 0) {
      return
    }
    const reads = pending.map((item) => {
      let read = reader.reads.get(item)
      if (!read) {
        read = (async () => {
          if (!(await supportsStructuredAgentSessionItemDetail(target))) {
            return
          }
          const full = await readStructuredAgentSessionItem(target, sessionId, item.itemId)
          if (
            full &&
            !full.shortened &&
            full.itemId === item.itemId &&
            full.body.kind === 'agent-start' &&
            item.body.kind === 'agent-start' &&
            full.body.dispatchId === item.body.dispatchId
          ) {
            reader.full.set(item, full)
          }
        })().catch(() => {})
        reader.reads.set(item, read)
      }
      return read
    })
    void Promise.all(reads).then(() => {
      if (active && pending.some((item) => reader.full.has(item))) {
        publish()
      }
    })
    return () => {
      active = false
    }
  }, [items, reader, sessionId, target])
  return useMemo(
    () => items.map((item) => reader.full.get(item) ?? item),
    [items, reader, revision]
  )
}
