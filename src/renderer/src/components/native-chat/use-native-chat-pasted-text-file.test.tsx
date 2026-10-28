// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import {
  insertNativeChatPastedText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import { useNativeChatPastedTextFile } from './use-native-chat-pasted-text-file'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import {
  clearNativeChatComposerDraftsForTests,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { promptEditor, promptValue } from './native-chat-prompt-editor.test-support'
import {
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'
import { imageReferencesToPromptMarkers } from '../../../../shared/native-chat-image-transcript-markers'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'

const save = vi.fn(() => new Promise<string>(() => {}))
const notice = vi.fn()
let paste: (text: string) => boolean
const SCOPE = 'agent-session:sizing'
const ID = '00000000-0000-4000-8000-000000000000'
const PAIRED_CHAT: NativeChatAttachmentOwner = {
  kind: 'runtime-session',
  environmentId: 'e1',
  sessionId: 's1',
  pairingRevision: 7
}
function Composer({
  text,
  owner = PAIRED_CHAT,
  structured = true
}: {
  text: string
  owner?: NativeChatAttachmentOwner
  structured?: boolean
}) {
  const input = useRef<NativeChatComposerInput>(null)
  paste = useNativeChatPastedTextFile({
    scopeKey: SCOPE,
    scopeEditor: () => input.current,
    structured,
    resolveAttachmentOwner: () => owner,
    insertTypedText: (value) => insertNativeChatPastedText(input.current, value),
    setNotice: notice
  })
  return (
    <NativeChatPromptEditor
      scopeKey={SCOPE}
      inputRef={input}
      initialValue={text}
      disabled={false}
      placeholder="Message"
      onChange={() => {}}
      onSelect={() => {}}
    />
  )
}
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  nativeChatPastedTextOperations.clear()
  vi.clearAllMocks()
})
it.each([
  { draft: 'a'.repeat(200 * 1024), text: '"'.repeat(30 * 1024) },
  { draft: 'z'.repeat(240 * 1024), text: 'q'.repeat(50 * 1024), replace: 200 * 1024 },
  { draft: '', text: 'é'.repeat(16 * 1024 + 1) },
  { draft: '', text: "$& $$ $` $'".repeat(4000) },
  { draft: '', text: 'c'.repeat(20 * 1024), image: 'p'.repeat(240 * 1024) },
  {
    draft: nativeChatPastedTextToken(ID),
    text: 'q',
    path: `/p/${'a'.repeat(256 * 1024 - 32)}`
  }
])(
  'matches the actual JSON/UTF-8 send body, including selection and path bytes',
  ({ draft, text, replace = 0, image = '', path = '' }) => {
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
    vi.stubGlobal('api', { ui: { savePastedTextAsFile: save } })
    updateNativeChatComposerDraft(
      SCOPE,
      {
        text: draft,
        images: image ? [{ id: 'i1', path: image }] : [],
        pastedTextFiles: path ? { [ID]: path } : {}
      },
      'immediate'
    )
    const view = render(<Composer text={draft} />)
    const editor = promptEditor(view.getByRole('textbox'))
    act(() => {
      if (replace) {
        editor.commands.setTextSelection({ from: 1, to: replace + 1 })
      } else {
        editor.commands.focus('end')
      }
    })
    const input = promptValue(view.getByRole('textbox'))
    const candidate = replace ? text + input.slice(replace) : input + text
    const projected = path
      ? candidate.replace(nativeChatPastedTextToken(ID), () => `@${path} `)
      : candidate
    const body = structuredAgentSessionSendBody(
      imageReferencesToPromptMarkers(projected, ['i1']),
      image ? [{ path: image, previewUri: '' }] : []
    )
    const tooLarge = structuredAgentSessionBlocksTooLarge(body.blocks)
    expect(tooLarge).toBe(Buffer.byteLength(JSON.stringify(body.blocks), 'utf8') > 256 * 1024)
    act(() => void paste(text))
    expect(promptValue(view.getByRole('textbox'))).toBe(tooLarge ? input : candidate)
    expect(save).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledTimes(tooLarge ? 1 : 0)
  }
)

it("saves a terminal-backed chat's long paste as a file, and never refuses one it must keep inline", () => {
  vi.stubGlobal('api', { ui: { savePastedTextAsFile: save } })
  const local = render(<Composer text="" owner={{ kind: 'local' }} structured={false} />)
  act(() => {
    promptEditor(local.getByRole('textbox')).commands.focus('end')
    paste('x'.repeat(40 * 1024))
  })
  expect(save).toHaveBeenCalledWith({ text: 'x'.repeat(40 * 1024) })
  expect(promptValue(local.getByRole('textbox')).length).toBeLessThan(100)
  local.unmount()
  clearNativeChatComposerDraftsForTests()

  // No message limit applies, so text the remote host can't take as a file still goes in.
  const remote = render(<Composer text="" owner={{ kind: 'remote' }} structured={false} />)
  act(() => {
    promptEditor(remote.getByRole('textbox')).commands.focus('end')
    paste('y'.repeat(300 * 1024))
  })
  expect(promptValue(remote.getByRole('textbox'))).toBe('y'.repeat(300 * 1024))
  expect(notice).not.toHaveBeenCalled()
  expect(save).toHaveBeenCalledTimes(1)
})
