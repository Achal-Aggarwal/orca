import { useCallback, useRef, type RefObject } from 'react'
import { notifyCombinedDiffDirectInput } from '../../combined-diff-viewport'

export type CombinedDiffDirectScrollInput = {
  hasDirectScrollInput: () => boolean
  markDirectScrollInput: () => void
}

export function useCombinedDiffDirectScrollInput(
  scrollContainerRef: RefObject<HTMLDivElement | null>
): CombinedDiffDirectScrollInput {
  const directScrollInputUntilRef = useRef(0)

  const markDirectScrollInput = useCallback((): void => {
    notifyCombinedDiffDirectInput(scrollContainerRef.current)
    directScrollInputUntilRef.current = window.performance.now() + 250
  }, [scrollContainerRef])

  const hasDirectScrollInput = useCallback(
    () => window.performance.now() < directScrollInputUntilRef.current,
    []
  )

  return { hasDirectScrollInput, markDirectScrollInput }
}
