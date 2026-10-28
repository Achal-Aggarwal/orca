import {
  nativeChatPastedTextId,
  NATIVE_CHAT_PASTED_TEXT_TOKEN
} from './native-chat-pasted-text-reference'

export type TerminalPasteSource = { id: string; text: string }
const sources = new Map<string, WeakRef<TerminalPasteSource>>()
const drafts = new Map<string, Map<string, TerminalPasteSource>>()
const finalized = new FinalizationRegistry<string>((id) => {
  if (!sources.get(id)?.deref()) {
    sources.delete(id)
  }
})

export function rememberTerminalPasteSource(source: TerminalPasteSource): void {
  if (sources.get(source.id)?.deref() === source) {
    return
  }
  sources.set(source.id, new WeakRef(source))
  finalized.register(source, source.id)
}

export function readTerminalPasteSource(id: string): TerminalPasteSource | undefined {
  return sources.get(id)?.deref()
}

export function retainTerminalPasteSources(scope: string, text: string): string[] {
  const held = new Map<string, TerminalPasteSource>()
  for (const token of text.split(NATIVE_CHAT_PASTED_TEXT_TOKEN)) {
    const id = nativeChatPastedTextId(token)
    const source = id ? readTerminalPasteSource(id) : undefined
    if (source) {
      held.set(source.id, source)
    }
  }
  if (held.size) {
    drafts.set(scope, held)
  } else {
    drafts.delete(scope)
  }
  return [...held.keys()]
}

export function terminalPasteSourceBodies(
  ids: readonly string[] = []
): ReadonlyMap<string, string> {
  return new Map(
    ids.flatMap((id) => {
      const source = readTerminalPasteSource(id)
      return source ? [[id, source.text] as const] : []
    })
  )
}

export function clearTerminalPasteSourcesForTests(): void {
  sources.clear()
  drafts.clear()
}
