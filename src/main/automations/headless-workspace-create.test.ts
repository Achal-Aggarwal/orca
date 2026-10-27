import { expect, it } from 'vitest'
import { buildHeadlessAutomationWorkspaceName } from './headless-workspace-create'

it('bounds automation workspace names while retaining the scheduled timestamp', () => {
  expect(
    buildHeadlessAutomationWorkspaceName('Nightly review run', Date.UTC(2026, 0, 2, 3, 4, 5))
  ).toBe('auto-nightly-review-run-20260102T0304')
  expect(buildHeadlessAutomationWorkspaceName('!', Date.UTC(2026, 0, 2))).toBe(
    'auto-run-20260102T0000'
  )
})
