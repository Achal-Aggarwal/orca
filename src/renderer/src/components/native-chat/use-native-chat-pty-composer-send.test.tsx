// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatSendClassification } from '../../../../shared/native-chat/input/native-chat-slash-commands'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import type * as RuntimeSend from './native-chat-runtime-send'
import { sendNativeChatMessage } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'

const handle = vi.hoisted(() => ({ cancel: () => {}, settleAfterMs: 0 }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => handle),
  sendNativeChatTypedCommand: vi.fn(() => handle),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn(() => handle)
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ clearNativeChatLaunchDraft: vi.fn() }) }
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))

function send(
  agent: AgentType,
  classification: NativeChatSendClassification,
  draft: string,
  imagePaths: string[] = []
) {
  const callbacks = { rejected: vi.fn(), unconfirmed: vi.fn(), submitted: vi.fn() }
  const { result } = renderHook(() =>
    useNativeChatPtyComposerSend({
      agent,
      draftScopeKey: 'terminal-test-scope',
      draft,
      imageAttachments: imagePaths.map((path) => ({ path })),
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId: 'pty', settings: null }),
      classifySend: () => classification,
      onOptimisticSend: () => 'pending-1',
      optimisticSendOutcome: { reject: callbacks.rejected, holdUnconfirmed: callbacks.unconfirmed },
      onSubmitted: callbacks.submitted,
      sessionOptionsSurface: null,
      terminalTabId: 'tab',
      trackPendingSend: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    })
  )
  result.current()
  return callbacks
}

beforeEach(() => {
  vi.mocked(sendNativeChatMessage).mockClear()
  vi.mocked(sendNativeChatMessageWithImageAttachments).mockClear()
})

it('routes a Claude chat send outcome to its own pending echo', () => {
  const callbacks = send('claude', 'chat', 'hello')
  const options = vi.mocked(sendNativeChatMessage).mock.calls[0]?.[2]
  options?.onWriteRejected?.()
  options?.onWriteUnconfirmed?.()
  expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
  expect(callbacks.unconfirmed).toHaveBeenCalledWith('pending-1')
})

it('routes a Claude image send outcome to its own pending echo', () => {
  const callbacks = send('claude', 'chat', 'look', ['/tmp/shot.png'])
  vi.mocked(sendNativeChatMessageWithImageAttachments).mock.calls[0]?.[4]?.onWriteRejected?.()
  expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
})

it.each([
  ['codex', 'chat', 'hello'],
  ['claude', 'command', '/compact']
] as const)('leaves a %s %s send on the unobserved write path', (agent, classification, draft) => {
  send(agent, classification, draft)
  expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.[2]?.onWriteRejected).toBeUndefined()
})

it.each([
  ['chat', 'hello'],
  ['command', '/compact'],
  ['unknown-token', '$my-skill do the thing']
] as const)('reports a %s send as submitted', (classification, draft) => {
  expect(send('codex', classification, draft).submitted).toHaveBeenCalledOnce()
})

it('reports nothing for a blank draft', () => {
  expect(send('codex', 'chat', '   ').submitted).not.toHaveBeenCalled()
})

it('rejects reserved unavailable identities while ordinary large terminal text stays inline', () => {
  send('claude', 'chat', '[Pasted text](orca-paste:00000000-0000-4000-8000-000000000000)')
  expect(sendNativeChatMessage).not.toHaveBeenCalled()
  const text = 'x'.repeat(300000)
  send('codex', 'chat', text)
  expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.slice(0, 2)).toEqual(['pty', text])
})

import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'
import {
  clearNativeChatComposerDraftsForTests,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { rememberTerminalPasteSource } from './native-chat-terminal-paste-sources'
import { nativeChatPastedTextToken } from './native-chat-pasted-text-reference'
import type { NativeChatTerminalTextInput } from '../../../../shared/native-chat-terminal-text-input'

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

it.each(['success', 'new typing', 'failure', 'cancel'] as const)(
  'materializes only explicit Send, preserving exact resolved input and %s outcomes',
  async (outcome) => {
    const id = '00000000-0000-4000-8000-000000000001'
    const legacy = '00000000-0000-4000-8000-000000000002'
    const token = nativeChatPastedTextToken(id)
    const source = { id, text: 'real source' }
    rememberTerminalPasteSource(source)
    const draft = `before${nativeChatPastedTextToken(legacy)} middle${token}after`
    const scope = 'terminal-test-scope'
    updateNativeChatComposerDraft(
      scope,
      { text: draft, pastedTextFiles: { [legacy]: '/old path/old.txt' } },
      'immediate'
    )
    const materialized = Promise.withResolvers<Record<string, string>>()
    const materialize = vi.fn((_input: NativeChatTerminalTextInput) => materialized.promise)
    const retire = vi.fn(async () => {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { materializeTerminalTextInput: materialize, retireTerminalTextInput: retire } }
    })
    const setDraft = vi.fn(),
      notice = vi.fn(),
      echo = vi.fn(() => 'pending-1')
    const track = vi.fn()
    const hook = renderHook(
      ({ text }) =>
        useNativeChatPtyComposerSend({
          agent: 'claude',
          draft: text,
          draftScopeKey: scope,
          imageAttachments: [],
          disabled: false,
          isDispatchingSessionOption: false,
          launchDraftResolved: true,
          resolveTarget: () => ({ ptyId: 'pty' }),
          classifySend: () => 'chat',
          onOptimisticSend: echo,
          sessionOptionsSurface: null,
          terminalTabId: 'tab',
          trackPendingSend: track,
          setDraft,
          setCaret: vi.fn(),
          clearSkillOrigin: vi.fn(),
          clearImageAttachments: vi.fn(),
          setNotice: notice
        }),
      { initialProps: { text: draft } }
    )
    act(() => {
      hook.result.current()
      hook.result.current()
    })
    await waitFor(() => expect(materialize).toHaveBeenCalledOnce())
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(materialize.mock.calls[0]?.[0]).toMatchObject({
      ptyId: 'pty',
      scopeKey: scope,
      sources: [source]
    })
    if (outcome === 'new typing') {
      updateNativeChatComposerDraft(scope, { text: 'new typing' }, 'immediate')
      hook.rerender({ text: 'new typing' })
    }
    if (outcome === 'cancel') {
      track.mock.calls[0]?.[0].cancel()
    }
    await act(async () =>
      outcome === 'failure'
        ? materialized.reject(new Error('disk full'))
        : materialized.resolve({ [id]: '/new path/paste.txt' })
    )
    if (outcome === 'cancel' || outcome === 'failure') {
      expect(sendNativeChatMessage).not.toHaveBeenCalled()
      expect(setDraft).not.toHaveBeenCalled()
      if (outcome === 'cancel') {
        expect(retire).toHaveBeenCalledOnce()
      } else {
        expect(notice).toHaveBeenCalled()
      }
    } else {
      const expected = 'before @"/old path/old.txt" middle @"/new path/paste.txt" after'
      expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.slice(0, 2)).toEqual(['pty', expected])
      expect(echo).toHaveBeenCalledWith(expected, [])
      expect(expected).not.toContain('orca-paste:')
      if (outcome === 'new typing') {
        expect(setDraft).not.toHaveBeenCalled()
      } else {
        expect(setDraft).toHaveBeenCalledWith('')
      }
      // The legacy completed-path route reaches precisely the same existing sender.
      vi.mocked(sendNativeChatMessage).mockClear()
      send('claude', 'chat', expected)
      expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.slice(0, 2)).toEqual(['pty', expected])
    }
  }
)

vi.mock('@/runtime/runtime-terminal-inspection', () => ({ sendRuntimePtyInput: vi.fn() }))

it('publishes a real file before the existing PTY clear/body/Enter queue and retains uncertain input across reopen', async () => {
  const fs = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { NativeChatTerminalTextInputs } =
    await import('../../../../main/window/native-chat-terminal-text-inputs')
  const actual = await vi.importActual<typeof RuntimeSend>('./native-chat-runtime-send')
  const { sendRuntimePtyInput } = await import('@/runtime/runtime-terminal-inspection')
  const { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } =
    await import('../../../../shared/native-chat-paste-bytes')
  const directory = await fs.mkdtemp(join(tmpdir(), 'orca-composer-input-'))
  try {
    const owner = new NativeChatTerminalTextInputs(directory)
    const materialize = vi.fn((input: NativeChatTerminalTextInput) => owner.materialize(input))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          materializeTerminalTextInput: materialize,
          retireTerminalTextInput: (input: NativeChatTerminalTextInput) => owner.retire(input)
        }
      }
    })
    const id = '00000000-0000-4000-8000-000000000003'
    const source = { id, text: 'the actual submitted content' }
    rememberTerminalPasteSource(source)
    const draft = `Read ${nativeChatPastedTextToken(id)}`
    updateNativeChatComposerDraft('terminal-test-scope', { text: draft }, 'immediate')
    vi.mocked(sendNativeChatMessage).mockImplementationOnce(actual.sendNativeChatMessage)
    send('codex', 'chat', draft)
    await waitFor(() => expect(sendNativeChatMessage).toHaveBeenCalledOnce())
    const input = materialize.mock.calls[0]![0]
    const paths = await materialize.mock.results[0]!.value
    const path = paths[id]!
    // The formatter only quotes paths containing whitespace.
    const { formatNativeChatFileReference } = await import('../../../../shared/agent-image-paste')
    expect(vi.mocked(sendNativeChatMessage).mock.calls[0]![1]).toBe(
      `Read ${formatNativeChatFileReference(path)}`
    )
    expect(await fs.readFile(path, 'utf8')).toBe(source.text)
    expect(
      JSON.parse(
        await fs.readFile(join(directory, 'published', input.requestId, 'input.json'), 'utf8')
      )
    ).toMatchObject({ input: draft, sourceIds: [id] })
    await waitFor(() =>
      expect(vi.mocked(sendRuntimePtyInput).mock.calls.at(-1)?.[1]).toBe(NATIVE_CHAT_SUBMIT)
    )
    expect(vi.mocked(sendRuntimePtyInput).mock.calls.map((call) => call[1])).toEqual([
      '\x15',
      buildNativeChatPasteBytes(`Read ${formatNativeChatFileReference(path)}`),
      NATIVE_CHAT_SUBMIT
    ])
    await new NativeChatTerminalTextInputs(directory).sweep()
    expect(await fs.readFile(path, 'utf8')).toBe(source.text)
  } finally {
    actual.resetNativeChatPtySendQueuesForTests()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
