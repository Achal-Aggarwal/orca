import type { AutomationRun } from '../../../src/shared/automations-types'
import { reconcileDesktopRunTerminals } from '../../../src/main/automations/desktop-run-terminal-reconciliation'
import { expect, vi } from 'vitest'
import type { Store } from '../../../src/main/persistence'
import type { createDesktopRunTerminalLifecycle } from '../../../src/main/automations/desktop-run-terminal-lifecycle'
import * as runNormalization from '../../../src/main/persistence/scheduling-automations/automation-context-migration'
import { compareAutomationRunsNewestFirst } from '../../../src/shared/automation-run-cursor'

export function measureTerminalInventory(
  disk: Store,
  lifecycle: ReturnType<typeof createDesktopRunTerminalLifecycle>,
  registered: ReadonlySet<string>
) {
  const list = disk.listAutomationRuns.bind(disk)
  let rows = 0,
    statusVisits = 0,
    linearFinds = 0,
    measuring = false
  const lists = vi.spyOn(disk, 'listAutomationRuns').mockImplementation((...args) => {
    const result = list(...args)
    if (!measuring) {
      return result
    }
    return new Proxy(result, {
      get(target, key, receiver) {
        if (key === 'find') {
          linearFinds++
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
        const value = Reflect.get(target, key, receiver)
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
          return value
        }
        rows++
        return new Proxy(value, {
          get(run, field, rowReceiver) {
            if (field === 'status') {
              statusVisits++
            }
            // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
            return Reflect.get(run, field, rowReceiver)
          }
        })
      }
    })
  })
  const normalized = vi.spyOn(runNormalization, 'normalizeAutomationPrecheckResult')
  const sorts = vi.spyOn(Array.prototype, 'sort')
  const lookups = vi.spyOn(Map.prototype, 'get')
  let inventories = 0,
    normalizations = 0,
    fullSorts = 0,
    selectedLookups = 0
  const reconcile = lifecycle.reconcile
  vi.spyOn(lifecycle, 'reconcile').mockImplementation(() => {
    const before = [
      lists.mock.calls.length,
      normalized.mock.calls.length,
      sorts.mock.calls.length,
      lookups.mock.calls.length
    ]
    measuring = true
    try {
      reconcile()
    } finally {
      measuring = false
    }
    inventories += lists.mock.calls.length - before[0]
    normalizations += normalized.mock.calls.length - before[1]
    fullSorts += sorts.mock.calls
      .slice(before[2])
      .filter(([compare]) => compare === compareAutomationRunsNewestFirst).length
    selectedLookups += lookups.mock.calls
      .slice(before[3])
      .filter(
        ([key], i) =>
          typeof key === 'string' &&
          registered.has(key) &&
          typeof lookups.mock.results[before[3] + i].value === 'string'
      ).length
  })
  return {
    lists,
    counts: () => ({
      inventories,
      normalizations,
      sorts: fullSorts,
      rows,
      statusVisits,
      linearFinds,
      selectedLookups
    })
  }
}

export function assertTerminalInventorySelection(run: AutomationRun): void {
  const released = vi.fn(),
    kept = vi.fn()
  const registrations = new Map([
    ['missing', { release: released }],
    ['failed', { release: released }],
    ['duplicate', { release: kept }],
    ...(['dispatching', 'dispatched', 'completed'] as const).map(
      (status) => [status, { release: kept }] as const
    )
  ])
  reconcileDesktopRunTerminals(registrations, () => [
    { ...run, id: 'duplicate', status: 'completed' },
    { ...run, id: 'duplicate', status: 'dispatch_failed' },
    { ...run, id: 'failed', status: 'dispatch_failed' },
    ...(['dispatching', 'dispatched', 'completed'] as const).map((status) => ({
      ...run,
      id: status,
      status
    }))
  ])
  expect(released).toHaveBeenCalledTimes(2)
  expect(kept).not.toHaveBeenCalled()
}
