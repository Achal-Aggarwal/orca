import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type {
  OrchestrationCompatibilitySshTerminal,
  TerminalHandleRecord
} from '../../runtime-terminal-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { PtyPane } from '../surface/pty-pane-query'

type IdentitySources = {
  handles: ReadonlyMap<string, TerminalHandleRecord>
  reverse: ReadonlyMap<string, string>
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptys: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  sshTerminals: ReadonlyMap<string, OrchestrationCompatibilitySshTerminal>
  capturePaneOf: () => (pty: RuntimePtyWorktreeRecord) => PtyPane
}

type OrderedKeys = Map<string, number>

/** Finite owner-read scratch: candidates retain source order; the existing getters select and repair. */
export class TerminalIdentityReadContext {
  private ssh: Map<string, string[]> | undefined
  private reverse: Map<string, OrderedKeys> | undefined
  private synthetic: Map<string, OrderedKeys> | undefined
  private leafKeys: Map<string, string[]> | undefined
  private panePtys: Map<string, OrderedKeys> | undefined
  private leafPtys: Map<string, OrderedKeys> | undefined
  private paneReader: ((pty: RuntimePtyWorktreeRecord) => PtyPane) | undefined
  private readonly reverseOrder = new Map<string, number>()
  private readonly handleOrder = new Map<string, number>()
  private readonly reverseFacts = new Map<string, string>()
  private readonly handleFacts = new Map<string, string>()

  constructor(private readonly source: IdentitySources) {}

  paneOf(pty: RuntimePtyWorktreeRecord): PtyPane {
    this.paneReader ??= this.source.capturePaneOf()
    return this.paneReader(pty)
  }

  sshAttachmentIds(handle: string): Iterable<string> {
    if (!this.ssh) {
      this.ssh = new Map()
      for (const [id, terminal] of this.source.sshTerminals) {
        const ids = this.ssh.get(terminal.handle) ?? []
        ids.push(id)
        this.ssh.set(terminal.handle, ids)
      }
    }
    return this.ssh.get(handle) ?? []
  }

  reversePtyIds(handle: string): readonly string[] {
    if (!this.reverse) {
      this.reverse = new Map()
      for (const [ptyId, mapped] of this.source.reverse) {
        this.reverseOrder.set(ptyId, this.reverseOrder.size)
        this.reverseFacts.set(ptyId, mapped)
        this.add(this.reverse, mapped, ptyId, this.reverseOrder.get(ptyId)!)
      }
    }
    return this.ordered(this.reverse.get(handle))
  }

  syntheticHandles(ptyId: string): Iterable<string> {
    if (!this.synthetic) {
      this.synthetic = new Map()
      for (const [handle, record] of this.source.handles) {
        this.handleOrder.set(handle, this.handleOrder.size)
        this.indexHandle(handle, record)
      }
    }
    return this.ordered(this.synthetic.get(ptyId))
  }

  leavesForId(leafId: string): Iterable<string> {
    if (!this.leafKeys) {
      this.leafKeys = new Map()
      for (const [key, leaf] of this.source.leaves) {
        const keys = this.leafKeys.get(leaf.leafId) ?? []
        keys.push(key)
        this.leafKeys.set(leaf.leafId, keys)
      }
    }
    return this.leafKeys.get(leafId) ?? []
  }

  ptysForPane(paneKey: string): Iterable<string> {
    if (!this.panePtys) {
      this.panePtys = new Map()
      this.leafPtys = new Map()
      let order = 0
      for (const [ptyId, pty] of this.source.ptys) {
        const pane = this.paneOf(pty).paneKey
        if (pane !== null) {
          this.add(this.panePtys, pane, ptyId, order)
          const parsed = parsePaneKey(pane)
          if (parsed) {
            this.add(this.leafPtys, parsed.leafId, ptyId, order)
          }
        }
        order++
      }
    }
    const exact = this.panePtys.get(paneKey)
    const parsed = parsePaneKey(paneKey)
    const suffix = parsed ? this.leafPtys?.get(parsed.leafId) : undefined
    return this.ordered(new Map([...(exact ?? []), ...(suffix ?? [])]))
  }

  /** Only keys written by the issuing owner are reconciled; no inventory rebuild follows repair. */
  changedReverseBinding(ptyId: string): void {
    if (!this.reverse) {
      return
    }
    const prior = this.reverseFacts.get(ptyId)
    if (prior !== undefined) {
      this.reverse.get(prior)?.delete(ptyId)
    }
    const handle = this.source.reverse.get(ptyId)
    if (handle !== undefined) {
      if (!this.reverseOrder.has(ptyId)) {
        this.reverseOrder.set(ptyId, this.reverseOrder.size)
      }
      this.add(this.reverse, handle, ptyId, this.reverseOrder.get(ptyId)!)
      this.reverseFacts.set(ptyId, handle)
    } else {
      this.reverseFacts.delete(ptyId)
    }
  }

  changedHandle(handle: string): void {
    if (!this.synthetic) {
      return
    }
    const prior = this.handleFacts.get(handle)
    if (prior !== undefined) {
      this.synthetic.get(prior)?.delete(handle)
      this.handleFacts.delete(handle)
    }
    const record = this.source.handles.get(handle)
    if (record) {
      if (!this.handleOrder.has(handle)) {
        this.handleOrder.set(handle, this.handleOrder.size)
      }
      this.indexHandle(handle, record)
    }
  }

  private indexHandle(handle: string, record: TerminalHandleRecord): void {
    if (record.ptyId && record.tabId.startsWith('pty:')) {
      this.add(this.synthetic!, record.ptyId, handle, this.handleOrder.get(handle)!)
      this.handleFacts.set(handle, record.ptyId)
    }
  }

  private add(index: Map<string, OrderedKeys>, key: string, value: string, order: number): void {
    const bucket = index.get(key) ?? new Map()
    bucket.set(value, order)
    index.set(key, bucket)
  }

  private ordered(keys: OrderedKeys | undefined): string[] {
    return [...(keys ?? [])].sort((a, b) => a[1] - b[1]).map(([key]) => key)
  }
}

export function ptyRecordForPaneKey(
  paneKey: string,
  source: {
    leaves: ReadonlyMap<string, RuntimeLeafRecord>
    ptys: ReadonlyMap<string, RuntimePtyWorktreeRecord>
    leafKey: (tab: string, leaf: string) => string
    paneOf: (pty: RuntimePtyWorktreeRecord) => PtyPane
  },
  context?: TerminalIdentityReadContext
): RuntimePtyWorktreeRecord | null {
  const parsed = parsePaneKey(paneKey)
  let leafPty: RuntimePtyWorktreeRecord | null = null
  if (parsed) {
    const leaf = source.leaves.get(source.leafKey(parsed.tabId, parsed.leafId))
    const pty = leaf?.ptyId ? source.ptys.get(leaf.ptyId) : undefined
    if (pty?.connected) {
      return pty
    }
    leafPty = pty ?? null
    const candidates = context ? context.leavesForId(parsed.leafId) : source.leaves.keys()
    for (const key of candidates) {
      const candidate = source.leaves.get(key)
      if (!candidate) {
        continue
      }
      if (candidate.leafId !== parsed.leafId || !candidate.ptyId) {
        continue
      }
      const remintedPty = source.ptys.get(candidate.ptyId)
      if (remintedPty?.connected) {
        return remintedPty
      }
      leafPty ??= remintedPty ?? null
    }
  }
  let newestMatch: RuntimePtyWorktreeRecord | null = null
  const candidates = context ? context.ptysForPane(paneKey) : source.ptys.keys()
  for (const ptyId of candidates) {
    const pty = source.ptys.get(ptyId)
    if (!pty) {
      continue
    }
    const recordedPaneKey = (context ? context.paneOf(pty) : source.paneOf(pty)).paneKey
    const ptyPane = parsePaneKey(recordedPaneKey ?? '')
    if (recordedPaneKey === paneKey || (parsed && ptyPane && parsed.leafId === ptyPane.leafId)) {
      if (pty.connected) {
        return pty
      }
      newestMatch = pty
    }
  }
  return leafPty ?? newestMatch
}
