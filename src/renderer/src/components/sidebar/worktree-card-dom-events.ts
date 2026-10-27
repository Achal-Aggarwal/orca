export function isEventTargetInsideCurrentTarget(
  currentTarget: EventTarget | null,
  target: EventTarget | null
): boolean {
  if (!(currentTarget instanceof Node) || !(target instanceof Node)) {
    return false
  }
  return currentTarget.contains(target)
}

// Touch and pen keep click activation so a press can still start a scroll.
export function isPlainPrimaryMousePress(event: {
  pointerType: string
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  return (
    event.pointerType === 'mouse' &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}
