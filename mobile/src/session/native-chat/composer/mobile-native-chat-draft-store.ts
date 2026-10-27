import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import { useSyncExternalStore, useCallback, type SetStateAction } from 'react'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'

// Text and its edit revision outlive the screen, including callbacks from an older mount.
type DraftAttachments = {
  images: PendingNativeChatImage[]
  files: readonly PendingNativeChatFile[]
}
type Draft = Partial<DraftAttachments> & {
  text: string
  editGeneration: number
}

const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()

// Seeded launch-context text per scope; null marks a permanent decline so a
// cleared composer never resurrects the prefill, even after leaving the screen.
export const mobileNativeChatLaunchDraftSeeds = new Map<
  string,
  MobileNativeChatLaunchDraftSeed | null
>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function writeDraft(draftKey: string, update: SetStateAction<string>, userEdit: boolean): void {
  const current = drafts.get(draftKey)
  const text = current?.text ?? ''
  const next = typeof update === 'function' ? update(text) : update
  if (next === text && !userEdit) {
    return
  }
  drafts.set(draftKey, {
    ...current,
    text: next,
    editGeneration: (current?.editGeneration ?? 0) + 1
  })
  if (next === text) {
    return
  }
  for (const listener of listeners) {
    listener()
  }
}

export function setMobileNativeChatDraftText(
  draftKey: string,
  update: SetStateAction<string>
): void {
  writeDraft(draftKey, update, false)
}

export function editMobileNativeChatDraft(draftKey: string, update: SetStateAction<string>): void {
  writeDraft(draftKey, update, true)
}

export function readMobileNativeChatDraftEditGeneration(draftKey: string): number {
  return drafts.get(draftKey)?.editGeneration ?? 0
}

export function clearMobileNativeChatDraftForSend(
  draftKey: string,
  editGeneration: number,
  text: string
): void {
  const current = drafts.get(draftKey)
  if ((current?.editGeneration ?? 0) === editGeneration && (current?.text ?? '') === text) {
    setMobileNativeChatDraftText(draftKey, '')
  }
}

export function useMobileNativeChatDraft(draftKey: string | null): string {
  const read = (): string => (draftKey ? (drafts.get(draftKey)?.text ?? '') : '')
  return useSyncExternalStore(subscribe, read, read)
}

export function resetMobileNativeChatDraftStoreForTests(): void {
  drafts.clear()
  attachmentId = 0
  mobileNativeChatLaunchDraftSeeds.clear()
}

const noImages: PendingNativeChatImage[] = []
const noFiles: readonly PendingNativeChatFile[] = []
function readDraftAttachments(draft: Draft | undefined): DraftAttachments {
  return { images: draft?.images ?? noImages, files: draft?.files ?? noFiles }
}
let attachmentId = 0
export function nextMobileDraftAttachmentId(prefix: string): string {
  return `${prefix}-${++attachmentId}`
}

export function useMobileDraftAttachments<K extends keyof DraftAttachments>(
  scope: string | null,
  kind: K
) {
  const read = (): DraftAttachments[K] =>
    readDraftAttachments(scope ? drafts.get(scope) : undefined)[kind]
  const value = useSyncExternalStore(subscribe, read, read)
  const update = useCallback(
    (key: string, change: (current: DraftAttachments[K]) => DraftAttachments[K]) => {
      const current = drafts.get(key) ?? { text: '', editGeneration: 0 }
      const next = change(readDraftAttachments(current)[kind])
      drafts.set(key, { ...current, [kind]: next })
      for (const listener of listeners) {
        listener()
      }
    },
    [kind]
  )
  return [value, update] as const
}

export type MobileComposerWriter = ((text: string) => boolean) & {
  captureOrigin?: () => (text: string) => boolean
}
