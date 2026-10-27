export type TerminalForegroundPresentation = 'agent-in-front' | 'not-in-front' | 'gone'

export type TerminalPresentationObservation = {
  state?: TerminalForegroundPresentation
  support: 'supported' | 'legacy'
  incarnationId: string
  version: number
}

/** Unknown never releases; a positive never selects Chat. */
export function decideTerminalForegroundPresentation(args: {
  accepted: TerminalForegroundPresentation | null | undefined
  currentBinding: boolean
  member: boolean
  wantsChat: boolean
}): 'release' | 'retain' {
  return args.currentBinding &&
    args.member &&
    args.wantsChat &&
    (args.accepted === 'not-in-front' || args.accepted === 'gone')
    ? 'release'
    : 'retain'
}

export function isTerminalPresentationObservation(
  value: unknown
): value is TerminalPresentationObservation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'incarnationId' in value &&
    typeof value.incarnationId === 'string' &&
    value.incarnationId.length > 0 &&
    'version' in value &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 0 &&
    'support' in value &&
    (value.support === 'supported' || value.support === 'legacy') &&
    (!('state' in value) ||
      value.state === undefined ||
      value.state === 'agent-in-front' ||
      value.state === 'not-in-front' ||
      value.state === 'gone')
  )
}
