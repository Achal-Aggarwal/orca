import type { Event as WatcherEvent } from '@parcel/watcher'

export type WslSnapshotEntry = {
  path: string
  type: string
  mtime: string
}

export type WslSnapshot = Map<string, WslSnapshotEntry>

export function diffWslSnapshots(
  prev: WslSnapshot,
  next: WslSnapshot,
  maxEvents: number
): WatcherEvent[] {
  const events: WatcherEvent[] = []

  for (const [entryPath, nextEntry] of next) {
    const prevEntry = prev.get(entryPath)
    if (!prevEntry) {
      events.push({ type: 'create', path: entryPath })
    } else if (prevEntry.type !== nextEntry.type) {
      events.push({ type: 'delete', path: entryPath })
      events.push({ type: 'create', path: entryPath })
    } else if (prevEntry.mtime !== nextEntry.mtime) {
      events.push({ type: 'update', path: entryPath })
    }
    if (events.length > maxEvents) {
      return events
    }
  }

  for (const entryPath of prev.keys()) {
    if (!next.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath })
      if (events.length > maxEvents) {
        return events
      }
    }
  }

  return events
}
