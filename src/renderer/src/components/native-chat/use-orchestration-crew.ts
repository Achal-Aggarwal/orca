import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { subscribeRuntimeRpc } from '@/runtime/runtime-rpc-subscribe'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  CrewFrame,
  emptyCrew,
  type OrchestrationCrewSnapshot
} from '../../../../shared/orchestration-crew'

const UNKNOWN = emptyCrew('unknown')
const unsupported = new Set<string>()
const entries = new Map<string, CrewSubscription>()

export class CrewSubscription {
  snapshot = UNKNOWN
  private pending: OrchestrationCrewSnapshot | undefined
  private readonly listeners = new Set<() => void>()
  private stop: (() => void) | undefined
  private active = false
  constructor(
    private readonly target: RuntimeClientTarget,
    private readonly party: string,
    private readonly generation: string,
    private readonly onIdle?: () => void
  ) {}
  private publish(snapshot: OrchestrationCrewSnapshot) {
    if (JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) {
      return
    }
    this.snapshot = snapshot
    this.listeners.forEach((listener) => listener())
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.active && !unsupported.has(this.generation)) {
      this.active = true
      let alive = true
      this.stop = () => {
        alive = false
      }
      void subscribeRuntimeRpc(
        this.target,
        'orchestration.crewSubscribe',
        { party: this.party },
        {
          onEvent: (value) => {
            if (!alive) {
              return
            }
            const parsed = CrewFrame.safeParse(value)
            if (!parsed.success) {
              this.publish(UNKNOWN)
              return
            }
            const frame = parsed.data
            if (frame.type === 'begin') {
              this.pending = emptyCrew(frame.status)
            } else if (frame.type === 'rows') {
              this.pending?.sections[frame.section].push(...frame.rows)
            } else if (frame.type === 'complete' && this.pending) {
              this.publish(this.pending)
              this.pending = undefined
            } else if (frame.type === 'end') {
              this.publish(UNKNOWN)
            }
          },
          onError: (error) => {
            if (!alive) {
              return
            }
            if (
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'method_not_found'
            ) {
              unsupported.add(this.generation)
            }
            this.pending = undefined
            this.publish(UNKNOWN)
          },
          onClose: () => {
            if (alive) {
              this.pending = undefined
              this.publish(UNKNOWN)
            }
          }
        }
      )
        .then((subscription) => {
          if (!alive) {
            subscription.unsubscribe()
          } else {
            this.stop = () => {
              alive = false
              subscription.unsubscribe()
            }
          }
        })
        .catch(() => {
          if (alive) {
            this.publish(UNKNOWN)
          }
        })
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.stop?.()
        this.stop = undefined
        this.active = false
        this.pending = undefined
        this.snapshot = UNKNOWN
        this.onIdle?.()
      }
    }
  }
  read = (): OrchestrationCrewSnapshot => this.snapshot
}

export function useOrchestrationCrew(
  target: RuntimeClientTarget | null,
  party: string | null
): OrchestrationCrewSnapshot {
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const pairingRevision = useSyncExternalStore(
    useCallback(
      (wake) => {
        const changed = (ids: readonly string[]) => {
          if (environmentId && ids.includes(environmentId)) {
            wake()
          }
        }
        const dispose = onRuntimeEnvironmentRevisionsChanged(changed)
        const retire = onRuntimeEnvironmentsRetired(changed)
        return () => {
          dispose()
          retire()
        }
      },
      [environmentId]
    ),
    () => (environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined)
  )
  const generation = useAppStore((state) => {
    if (!environmentId) {
      return 'local'
    }
    const entry = state.runtimeStatusByEnvironmentId?.get(environmentId)
    if (!entry?.status) {
      return `offline:${environmentId}`
    }
    return JSON.stringify([
      environmentId,
      pairingRevision,
      entry.status.runtimeId,
      entry.connectionGeneration,
      entry.hostContactEpoch
    ])
  })
  const key = target && party ? JSON.stringify([target, party, generation]) : null
  const entry = useMemo(() => {
    if (!key || !target || !party || generation.startsWith('offline:')) {
      return null
    }
    let entry = entries.get(key)
    if (!entry) {
      const created = new CrewSubscription(target, party, generation, () => {
        if (entries.get(key) === created) {
          entries.delete(key)
        }
      })
      entry = created
      entries.set(key, entry)
    }
    return entry
  }, [key, generation, target, party])
  const subscribe = useCallback(
    (listener: () => void) => entry?.subscribe(listener) ?? (() => {}),
    [entry]
  )
  return useSyncExternalStore(subscribe, entry?.read ?? (() => UNKNOWN))
}
