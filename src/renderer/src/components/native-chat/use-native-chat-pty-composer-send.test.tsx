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
vi.mock('./native-chat-runtime-send', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeSend>()),
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

import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import { readNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { readTerminalPasteSource } from './native-chat-terminal-paste-sources'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-verified-input'
const terminalData = vi.hoisted(() => ({ receive: (_data: string) => {} }))
vi.mock('../terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: (_pty: string, receive: (data: string) => void) => {
    terminalData.receive = receive
    return () => {}
  }
}))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: vi.fn(async () => true)
}))

it.each([
  ['codex', 'active'],
  ['codex', 'finished'],
  ['claude', 'active'],
  ['claude', 'finished']
] as const)(
  'cancels staged preparation when a %s option is %s, preserves source and allows explicit retry',
  async (agent, schedule) => {
    vi.useFakeTimers()
    const actual = await vi.importActual<typeof RuntimeSend>('./native-chat-runtime-send')
    actual.resetNativeChatPtySendQueuesForTests()
    vi.mocked(sendRuntimePtyInput).mockClear().mockReturnValue(true)
    vi.mocked(sendRuntimePtyInputVerified).mockClear()
    vi.mocked(sendNativeChatMessage).mockImplementation(actual.sendNativeChatMessage)
    const id = '00000000-0000-4000-8000-000000000004'
    const source = { id, text: 'retained original source' }
    rememberTerminalPasteSource(source)
    const scope = 'terminal-test-scope'
    const draft = `Read ${nativeChatPastedTextToken(id)}`
    updateNativeChatComposerDraft(scope, { text: draft }, 'immediate')
    const pending = Promise.withResolvers<Record<string, string>>()
    const materialize = vi.fn(async (_input: NativeChatTerminalTextInput) => pending.promise)
    const retire = vi.fn(async (_input: NativeChatTerminalTextInput) => {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { materializeTerminalTextInput: materialize, retireTerminalTextInput: retire } }
    })
    const handles: RuntimeSend.NativeChatSendHandle[] = []
    const setDraft = vi.fn()
    let optionPromise: ReturnType<
      ReturnType<typeof useNativeChatSessionOptionCommand>['dispatch']
    > = undefined
    const finishOption = async () => {
      await vi.advanceTimersByTimeAsync(2000)
      if (agent === 'claude') {
        terminalData.receive('Set model to Sonnet')
      }
      await optionPromise
    }
    const hook = renderHook(() => {
      const lifecycle = useNativeChatSendLifecycle('tab', 'pty')
      const option = useNativeChatSessionOptionCommand({
        agent,
        disabled: false,
        resolveTarget: () => ({ ptyId: 'pty' })
      })
      const send = useNativeChatPtyComposerSend({
        agent,
        draft,
        draftScopeKey: scope,
        imageAttachments: [],
        disabled: false,
        isDispatchingSessionOption: option.isDispatching,
        launchDraftResolved: true,
        resolveTarget: () => ({ ptyId: 'pty' }),
        classifySend: () => 'chat',
        sessionOptionsSurface: null,
        terminalTabId: 'tab',
        trackPendingSend: (handle) => {
          handles.push(handle)
          lifecycle.trackPendingSend(handle)
        },
        setDraft,
        setCaret: vi.fn(),
        clearSkillOrigin: vi.fn(),
        clearImageAttachments: vi.fn(),
        setNotice: vi.fn()
      })
      return { send, option }
    })
    try {
      await act(async () => hook.result.current.send())
      expect(materialize).toHaveBeenCalledOnce()
      await act(async () => {
        optionPromise = hook.result.current.option.dispatch(
          agent === 'codex' ? '/model gpt-5.4' : '/model sonnet',
          agent === 'claude'
            ? {
                detectAgentInteraction: 'claude-model-switch-confirmation',
                expectedChoiceLabel: 'Sonnet'
              }
            : undefined
        )
        Promise.resolve(optionPromise).catch(() => {})
      })
      // The option owns the existing PTY without waiting for the disk promise.
      expect(sendRuntimePtyInputVerified).toHaveBeenCalled()
      if (agent === 'claude') {
        await act(async () => vi.advanceTimersByTimeAsync(300))
        terminalData.receive('Switch model? This conversation is cached for the current model')
        expect(vi.mocked(sendRuntimePtyInput).mock.calls.at(-1)?.[1]).toBe('\r')
      }
      if (schedule === 'finished') {
        await act(async () => {
          await finishOption()
        })
        expect(hook.result.current.option.isDispatching).toBe(false)
      } else {
        expect(hook.result.current.option.isDispatching).toBe(true)
      }
      let preparationSettled = false
      void handles[0]?.settled?.then(() => {
        preparationSettled = true
      })
      await act(async () => {})
      expect(preparationSettled).toBe(true)
      expect(materialize).toHaveBeenCalledOnce()
      vi.mocked(sendRuntimePtyInput).mockClear()
      await act(async () => pending.resolve({ [id]: '/published/paste.txt' }))
      expect(sendNativeChatMessage).not.toHaveBeenCalled()
      expect(sendRuntimePtyInput).not.toHaveBeenCalled()
      expect(retire).toHaveBeenCalledOnce()
      await handles[0]?.settled
      expect(setDraft).not.toHaveBeenCalled()
      expect(readNativeChatComposerDraft(scope).text).toBe(draft)
      expect(readTerminalPasteSource(id)?.text).toBe(source.text)
      if (schedule === 'active') {
        await act(async () => {
          await finishOption()
        })
      }
      materialize.mockResolvedValue({ [id]: '/retry/paste.txt' })
      await act(async () => hook.result.current.send())
      expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.slice(0, 2)).toEqual([
        'pty',
        'Read @/retry/paste.txt'
      ])
      await act(async () => vi.runAllTimersAsync())
      expect(retire).toHaveBeenCalledOnce()
    } finally {
      await act(async () => finishOption())
      hook.unmount()
      actual.resetNativeChatPtySendQueuesForTests()
      vi.useRealTimers()
      vi.mocked(sendNativeChatMessage).mockReset().mockReturnValue(handle)
    }
  }
)

it.each(['inline', 'completed'] as const)(
  'preserves existing %s cancellation and option rejection without deferred Enter or automatic retry',
  async (format) => {
    vi.useFakeTimers()
    const actual = await vi.importActual<typeof RuntimeSend>('./native-chat-runtime-send')
    actual.resetNativeChatPtySendQueuesForTests()
    vi.mocked(sendNativeChatMessage).mockImplementation(actual.sendNativeChatMessage)
    vi.mocked(sendRuntimePtyInput).mockClear().mockReturnValue(true)
    vi.mocked(sendRuntimePtyInputVerified).mockClear().mockResolvedValueOnce(false)
    const id = '00000000-0000-4000-8000-000000000005'
    const draft = format === 'inline' ? 'original inline content' : nativeChatPastedTextToken(id)
    const expected = format === 'inline' ? draft : '@/existing/completed.txt'
    updateNativeChatComposerDraft(
      'terminal-test-scope',
      {
        text: draft,
        pastedTextFiles: format === 'completed' ? { [id]: '/existing/completed.txt' } : {}
      },
      'immediate'
    )
    const setDraft = vi.fn()
    const hook = renderHook(() => {
      const lifecycle = useNativeChatSendLifecycle('tab', 'pty')
      const option = useNativeChatSessionOptionCommand({
        agent: 'codex',
        disabled: false,
        resolveTarget: () => ({ ptyId: 'pty' })
      })
      const send = useNativeChatPtyComposerSend({
        agent: 'codex',
        draft,
        draftScopeKey: 'terminal-test-scope',
        imageAttachments: [],
        disabled: false,
        isDispatchingSessionOption: option.isDispatching,
        launchDraftResolved: true,
        resolveTarget: () => ({ ptyId: 'pty' }),
        classifySend: () => 'chat',
        sessionOptionsSurface: null,
        terminalTabId: 'tab',
        trackPendingSend: lifecycle.trackPendingSend,
        setDraft,
        setCaret: vi.fn(),
        clearSkillOrigin: vi.fn(),
        clearImageAttachments: vi.fn(),
        setNotice: vi.fn()
      })
      return { send, option }
    })
    try {
      act(() => hook.result.current.send())
      expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.slice(0, 2)).toEqual(['pty', expected])
      expect(setDraft).toHaveBeenCalledWith('')
      await act(async () => {
        await expect(hook.result.current.option.dispatch('/model gpt-5.4')).rejects.toThrow(
          'terminal did not accept'
        )
      })
      vi.mocked(sendRuntimePtyInput).mockClear()
      await act(async () => vi.runAllTimersAsync())
      expect(sendRuntimePtyInput).not.toHaveBeenCalled()
      expect(sendNativeChatMessage).toHaveBeenCalledOnce()
      act(() => hook.result.current.send())
      await act(async () => vi.runAllTimersAsync())
      expect(sendNativeChatMessage).toHaveBeenCalledTimes(2)
      expect(vi.mocked(sendRuntimePtyInput).mock.calls.at(-1)?.[1]).toBe('\r')
    } finally {
      hook.unmount()
      actual.resetNativeChatPtySendQueuesForTests()
      vi.useRealTimers()
      vi.mocked(sendNativeChatMessage).mockReset().mockReturnValue(handle)
    }
  }
)

it.each([1, 10])(
  'bounds real staged-send cancellation at %i preparations without waiting for disk or touching another PTY',
  async (count) => {
    vi.useFakeTimers()
    const actual = await vi.importActual<typeof RuntimeSend>('./native-chat-runtime-send')
    actual.resetNativeChatPtySendQueuesForTests()
    vi.mocked(sendRuntimePtyInputVerified).mockResolvedValue(true)
    const pending = Promise.withResolvers<Record<string, string>>()
    const materialize = vi.fn(async (_input: NativeChatTerminalTextInput) => pending.promise)
    const retire = vi.fn(async (_input: NativeChatTerminalTextInput) => {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { materializeTerminalTextInput: materialize, retireTerminalTextInput: retire } }
    })
    const id = '00000000-0000-4000-8000-000000000006'
    rememberTerminalPasteSource({ id, text: 'bounded source' })
    const handles: RuntimeSend.NativeChatSendHandle[] = []
    const views: { unmount: () => void }[] = []
    try {
      for (let index = 0; index <= count; index++) {
        const scope = `preparation-${index}`
        const draft = nativeChatPastedTextToken(id)
        updateNativeChatComposerDraft(scope, { text: draft }, 'immediate')
        const hook = renderHook(() =>
          useNativeChatPtyComposerSend({
            agent: 'codex',
            draft,
            draftScopeKey: scope,
            imageAttachments: [],
            disabled: false,
            isDispatchingSessionOption: false,
            launchDraftResolved: true,
            resolveTarget: () => ({ ptyId: index === count ? 'other-pty' : 'pty' }),
            classifySend: () => 'chat',
            sessionOptionsSurface: null,
            terminalTabId: scope,
            trackPendingSend: (handle) => {
              handles.push(handle)
              vi.spyOn(handle, 'cancel')
            },
            setDraft: vi.fn(),
            setCaret: vi.fn(),
            clearSkillOrigin: vi.fn(),
            clearImageAttachments: vi.fn(),
            setNotice: vi.fn()
          })
        )
        views.push(hook)
        await act(async () => hook.result.current())
      }
      const option = renderHook(() =>
        useNativeChatSessionOptionCommand({
          agent: 'codex',
          disabled: false,
          resolveTarget: () => ({ ptyId: 'pty' })
        })
      )
      views.push(option)
      let completed = false
      await act(async () => {
        void Promise.resolve(option.result.current.dispatch('/model gpt-5.4')).then(() => {
          completed = true
        })
      })
      await act(async () => vi.runAllTimersAsync())
      expect(completed).toBe(true)
      expect(materialize).toHaveBeenCalledTimes(count + 1)
      for (const handle of handles.slice(0, count)) {
        expect(handle.cancel).toHaveBeenCalledOnce()
        await handle.settled
      }
      expect(handles[count]?.cancel).not.toHaveBeenCalled()
      // Close the unrelated preparation without handing its input to the PTY.
      handles[count]?.cancel()
      await act(async () => pending.resolve({ [id]: '/published/bounded.txt' }))
      expect(retire).toHaveBeenCalledTimes(count + 1)
      expect(sendNativeChatMessage).not.toHaveBeenCalled()
    } finally {
      views.forEach((view) => view.unmount())
      actual.resetNativeChatPtySendQueuesForTests()
      vi.useRealTimers()
    }
  }
)
