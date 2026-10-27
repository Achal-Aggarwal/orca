import { expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

it('marks desktop scheduling ready without installing a renderer-only launcher', async () => {
  vi.doMock('react', async () => ({
    ...(await vi.importActual<typeof ReactModule>('react')),
    useEffect: (effect: () => void) => effect()
  }))
  const rendererReady = vi.fn()
  const onDispatchRequested = vi.fn()
  vi.stubGlobal('window', { api: { automations: { rendererReady, onDispatchRequested } } })
  const { useAutomationDispatchEvents } = await import('./useAutomationDispatchEvents')
  useAutomationDispatchEvents()
  expect(rendererReady).toHaveBeenCalledOnce()
  expect(onDispatchRequested).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
