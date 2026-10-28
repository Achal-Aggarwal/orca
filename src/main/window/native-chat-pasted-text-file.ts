// A structured chat's pasted text uses the execution host's attachment store so sends claim it with the chat.
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  agentSessionPastedTextName,
  type AgentSessionAttachmentClipboardTarget
} from '../../shared/agent-session-attachments'
import { assertClipboardTextWithinLimit } from '../../shared/clipboard-text'
import { uploadPasteToAgentSessionAttachments } from '../ipc/agent-session-attachment-upload'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { nativeChatPasteFolder } from './native-chat-paste-files'

export type SavePastedTextAsFileArgs = {
  text: string
  /** With `agentSessionAttachment`: the paired server whose chat stores the file. */
  runtimeEnvironmentId?: string | null
  agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  /** A structured chat on this machine, whose sends claim its pastes from the chat attachment store. */
  forStructuredChat?: boolean
}

export async function savePastedTextAsFile(
  args: SavePastedTextAsFileArgs,
  localStore?: () => Promise<AgentSessionAttachmentStore | null>
): Promise<string> {
  if (typeof args?.text !== 'string') {
    throw new Error('Pasted text is missing.')
  }
  assertClipboardTextWithinLimit(args.text)
  const buffer = Buffer.from(args.text, 'utf8')
  const name = agentSessionPastedTextName(Date.now(), randomUUID())
  const runtimeEnvironmentId = args.runtimeEnvironmentId?.trim()
  if (runtimeEnvironmentId && args.agentSessionAttachment) {
    return uploadPasteToAgentSessionAttachments(
      args.agentSessionAttachment,
      runtimeEnvironmentId,
      app.getPath('userData'),
      buffer,
      name
    )
  }
  // Terminal-backed sends claim nothing, so their pastes stay in the paste folder, which never expires.
  if (args.forStructuredChat !== true) {
    const folder = nativeChatPasteFolder()
    await mkdir(folder, { recursive: true })
    const path = join(folder, name)
    await writeFile(path, buffer)
    return path
  }
  const store = await localStore?.()
  if (!store) {
    throw new Error('The chat attachment store is not ready.')
  }
  return store.storeFile(name, buffer)
}
