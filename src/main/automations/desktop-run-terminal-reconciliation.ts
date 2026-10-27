import type { AutomationRun } from '../../shared/automations-types'

export function reconcileDesktopRunTerminals(
  registrations: ReadonlyMap<string, { release: () => void }>,
  listRuns: () => readonly AutomationRun[]
): void {
  if (registrations.size === 0) {
    return
  }
  const statuses = new Map<string, AutomationRun['status']>()
  for (const run of listRuns()) {
    if (!statuses.has(run.id)) {
      statuses.set(run.id, run.status)
    }
  }
  for (const [id, owner] of registrations) {
    const status = statuses.get(id)
    if (!status || !['dispatching', 'dispatched', 'completed'].includes(status)) {
      owner.release()
    }
  }
}
