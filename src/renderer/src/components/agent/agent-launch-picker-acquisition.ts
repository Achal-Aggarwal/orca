import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** Pending local IPC outlives observers; matching menus must retain its physical owner. */
const pending = new Map<string, AgentPickerAcquisition>()
type Observer = {
  publish: (entries: AgentPickerEntry[]) => void
  selected: () => TuiAgent | undefined
}
type Reads = {
  settings?: () => Promise<AgentPickerEntry[] | undefined>
  catalog: (entry: AgentPickerEntry) => Promise<AgentPickerEntry['catalog'] | undefined>
  support: (entry: AgentPickerEntry) => Promise<AgentPickerEntry['structured'] | undefined>
}

class AgentPickerAcquisition {
  readonly observers = new Set<Observer>()
  entries: AgentPickerEntry[]
  settingsPending = false
  private outstanding = { catalog: 0, support: 0 }
  private queued: Record<'catalog' | 'support', Set<number>>
  private supports = new Map<number, AgentPickerEntry['structured']>()

  constructor(
    readonly key: string,
    entries: AgentPickerEntry[],
    private reads: Reads
  ) {
    this.entries = entries
    this.queued = {
      catalog: new Set(entries.flatMap((e, i) => (e.surfaces.length ? [i] : []))),
      support: new Set(entries.flatMap((e, i) => (e.structuredDefaultsPending ? [i] : [])))
    }
  }

  observe(observer: Observer) {
    const first = this.observers.size === 0
    this.observers.add(observer)
    if (first && !this.settingsPending && this.reads.settings) {
      this.readSettings(this.reads.settings)
    }
    observer.publish(this.entries)
    this.admit('catalog')
    this.admit('support')
    return () => {
      this.observers.delete(observer)
      this.retire()
    }
  }

  private publish() {
    for (const observer of this.observers) {
      observer.publish(this.entries)
    }
  }

  private readSettings(read: NonNullable<Reads['settings']>) {
    this.settingsPending = true
    this.entries = this.entries.map((e) => ({ ...e, defaultsPending: true }))
    void read()
      .catch(() => undefined)
      .then((entries) => {
        if (entries) {
          this.entries = entries.map((e, i) => ({
            ...e,
            catalog: this.entries[i].catalog,
            structured: this.supports.get(i) ?? e.structured,
            structuredDefaultsPending: this.entries[i].structuredDefaultsPending
          }))
        }
        this.settingsPending = false
        this.publish()
        this.retire()
      })
  }

  private admit(kind: 'catalog' | 'support') {
    while (this.observers.size && this.outstanding[kind] < 2 && this.queued[kind].size) {
      const priorities = [...this.observers].map((o) => o.selected())
      const preferred = this.entries.findIndex((e) => priorities.includes(e.agent))
      const index = this.queued[kind].has(preferred)
        ? preferred
        : this.queued[kind].values().next().value
      if (index === undefined) {
        break
      }
      this.queued[kind].delete(index)
      this.outstanding[kind]++
      const entry = this.entries[index]
      const read =
        kind === 'catalog'
          ? this.reads.catalog(entry).then((catalog) => {
              if (catalog) {
                this.entries = this.entries.map((e, i) => (i === index ? { ...e, catalog } : e))
              }
            })
          : this.reads.support(entry).then(
              (structured) => {
                if (structured) {
                  this.supports.set(index, structured)
                }
                this.entries = this.entries.map((e, i) =>
                  i === index
                    ? {
                        ...e,
                        structured: structured ?? e.structured,
                        structuredDefaultsPending: false
                      }
                    : e
                )
              },
              () => {
                this.entries = this.entries.map((e, i) =>
                  i === index ? { ...e, structuredDefaultsPending: false } : e
                )
              }
            )
      void read
        .catch(() => undefined)
        .then(() => {
          this.outstanding[kind]--
          this.publish()
          this.admit(kind)
          this.retire()
        })
    }
  }

  private retire() {
    if (
      !this.observers.size &&
      !this.settingsPending &&
      !this.outstanding.catalog &&
      !this.outstanding.support
    ) {
      pending.delete(this.key)
    }
  }

  diagnostics() {
    return {
      observers: this.observers.size,
      settings: Number(this.settingsPending),
      ...this.outstanding
    }
  }
}

export function observeAgentPickerAcquisition(
  key: string,
  entries: AgentPickerEntry[],
  reads: Reads,
  observer: Observer
) {
  let resource = pending.get(key)
  if (!resource) {
    resource = new AgentPickerAcquisition(key, entries, reads)
    pending.set(key, resource)
  }
  return resource.observe(observer)
}

export function currentAgentPickerAcquisition(key: string) {
  const resource = pending.get(key)
  // A new open after settled settings requires fresh authority, even if optional IPC is hung.
  return resource && (resource.settingsPending || resource.observers.size)
    ? resource.entries
    : undefined
}

export function agentPickerAcquisitionDiagnostics() {
  return [...pending.values()].map((resource) => ({ key: resource.key, ...resource.diagnostics() }))
}
