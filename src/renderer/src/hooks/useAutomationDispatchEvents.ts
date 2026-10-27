import { useEffect } from 'react'

export function useAutomationDispatchEvents(): void {
  useEffect(() => {
    void window.api.automations.rendererReady()
  }, [])
}
