import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  resetNativeChatPtySendQueuesForTests,
  sendNativeChatMessage
} from './native-chat-runtime-send'
import {
  NATIVE_CHAT_SUBMIT,
  buildNativeChatPasteBytes
} from '../../../../shared/native-chat-paste-bytes'

vi.mock('@/runtime/runtime-terminal-inspection', () => ({ sendRuntimePtyInput: () => true }))
vi.mock('@/runtime/runtime-terminal-stream', () => ({ getRemoteRuntimePtyOwner: () => null }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
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
