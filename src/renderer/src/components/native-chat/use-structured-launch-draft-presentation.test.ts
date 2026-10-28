// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useStructuredLaunchDraftPresentation } from './use-structured-launch-draft-presentation'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-registry', () => ({
  getStructuredLaunchStateBySessionId: mocks.getState
}))

it('records presentation when a draft join arrives after the empty composer mounted', () => {
  const view = renderHook(({ draft }) => useStructuredLaunchDraftPresentation('session', draft), {
    initialProps: { draft: '' }
  })
  const receipt = { scopeKey: 'agent-session:session', text: 'hand-off', presented: false }
  mocks.getState.mockReturnValue({ draftReceipt: receipt })
  view.rerender({ draft: 'hand-off' })
  expect(receipt.presented).toBe(true)
  view.unmount()
  expect(receipt.presented).toBe(true)
})
