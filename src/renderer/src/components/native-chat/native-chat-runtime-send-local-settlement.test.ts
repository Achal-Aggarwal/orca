import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  resetNativeChatPtySendQueuesForTests,
  sendNativeChatMessage
} from './native-chat-runtime-send'
import {
  NATIVE_CHAT_SUBMIT,
  buildNativeChatPasteBytes
} from '../../../../shared/native-chat-paste-bytes'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'

const remote = vi.hoisted(() => ({ owner: vi.fn(), rpc: vi.fn() }))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({ sendRuntimePtyInput: () => true }))
vi.mock('@/runtime/runtime-terminal-stream', () => ({ getRemoteRuntimePtyOwner: remote.owner }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: remote.rpc }))
vi.mock('@/runtime/runtime-terminal-input-recording', () => ({
  recordRuntimeTerminalInputForPtyId: vi.fn()
}))

const writeAccepted = vi.fn()
const write = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  resetNativeChatPtySendQueuesForTests()
  write.mockReset()
  writeAccepted.mockReset().mockResolvedValue(true)
  remote.owner.mockReset().mockReturnValue(null)
  remote.rpc.mockReset()
  vi.stubGlobal('window', { api: { pty: { write, writeAccepted } } })
})
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['body', 'Enter'] as const)(
  'reports a real local %s refusal without a fallback write',
  async (refused) => {
    const rejected = vi.fn()
    if (refused === 'Enter') {
      writeAccepted.mockResolvedValueOnce(true)
    }
    writeAccepted.mockResolvedValueOnce(false)
    sendNativeChatMessage('local', 'refused', { onWriteRejected: rejected })
    await vi.advanceTimersByTimeAsync(1000)
    expect(rejected).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    expect(writeAccepted.mock.calls.map((call) => call[1])).toEqual(
      refused === 'body'
        ? [buildNativeChatPasteBytes('refused')]
        : [buildNativeChatPasteBytes('refused'), NATIVE_CHAT_SUBMIT]
    )
  }
)

it.each([
  ['local', 'refused'],
  ['local', 'unknown'],
  ['current', 'accepted'],
  ['current', 'refused'],
  ['current', 'unknown'],
  ['legacy', 'accepted'],
  ['legacy', 'refused'],
  ['legacy', 'unknown']
] as const)(
  'settles a %s %s result and delivers the next queued send without replay',
  async (host, outcome) => {
    const rejected = vi.fn()
    const unconfirmed = vi.fn()
    const settled = vi.fn()
    const accepted: RuntimeTerminalSend = {
      handle: 'terminal',
      accepted: true,
      bytesWritten: 1
    }
    if (host === 'local') {
      if (outcome === 'unknown') {
        writeAccepted.mockRejectedValueOnce(new Error('local acknowledgment lost'))
      } else {
        writeAccepted.mockResolvedValueOnce(false)
      }
    } else {
      remote.owner.mockReturnValue({
        target: { kind: 'environment', environmentId: 'paired' },
        terminal: 'terminal'
      })
      remote.rpc.mockResolvedValue({ send: accepted })
      if (host === 'legacy' && outcome === 'unknown') {
        remote.rpc.mockRejectedValueOnce(new Error('remote acknowledgment lost'))
      } else {
        const send: RuntimeTerminalSend = {
          ...accepted,
          accepted: outcome !== 'refused',
          ...(host === 'current'
            ? {
                writeSettlement:
                  outcome === 'accepted'
                    ? { outcome: 'accepted' }
                    : outcome === 'refused'
                      ? { outcome: 'refused', reason: 'provider_refused_write' }
                      : {
                          outcome: 'unverifiable',
                          reason: 'settlement_timeout',
                          bytesHandedToTransport: true
                        }
              }
            : {})
        }
        remote.rpc.mockResolvedValueOnce({ send })
      }
    }
    const first = sendNativeChatMessage('pane', 'first', {
      onWriteRejected: rejected,
      onWriteUnconfirmed: unconfirmed,
      onDeliverySettled: settled
    })
    const nextSettled = vi.fn()
    const next = sendNativeChatMessage('pane', 'next', { onDeliverySettled: nextSettled })
    await vi.advanceTimersByTimeAsync(2_000)
    await Promise.all([first.settled, next.settled])
    expect(rejected).toHaveBeenCalledTimes(outcome === 'refused' ? 1 : 0)
    expect(unconfirmed).toHaveBeenCalledTimes(outcome === 'unknown' ? 1 : 0)
    expect(settled).toHaveBeenCalledExactlyOnceWith(outcome === 'accepted')
    expect(nextSettled).toHaveBeenCalledExactlyOnceWith(true)
    expect(write).not.toHaveBeenCalled()
    const bytes =
      host === 'local'
        ? writeAccepted.mock.calls.map((call) => call[1])
        : remote.rpc.mock.calls.map((call) => call[2].text)
    expect(bytes).toEqual([
      buildNativeChatPasteBytes('first'),
      ...(outcome === 'refused' ? [] : [NATIVE_CHAT_SUBMIT]),
      buildNativeChatPasteBytes('next'),
      NATIVE_CHAT_SUBMIT
    ])
    if (host === 'local') {
      for (const call of writeAccepted.mock.calls) {
        expect(call[3]).toEqual({ requireWriteSettlement: true })
      }
    } else {
      for (const call of remote.rpc.mock.calls) {
        expect(call).toEqual([
          { kind: 'environment', environmentId: 'paired' },
          'terminal.send',
          {
            terminal: 'terminal',
            text: expect.any(String),
            client: { id: 'orca-desktop', type: 'desktop' },
            requireWriteSettlement: true
          },
          { timeoutMs: 15_000 }
        ])
      }
    }
  }
)
