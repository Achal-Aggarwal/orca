import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ write: vi.fn(), verified: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: io.write
}))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: io.verified
}))
import {
  sendNativeChatMessage,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-runtime-send'
import {
  buildNativeChatPasteBytes,
  buildNativeChatImagePasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../shared/native-chat-paste-bytes'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import {
  AGENT_TUI_CLEAR_INPUT_MAX,
  buildAgentTuiClearInputForText
} from '../../../../shared/agent-tui-input-clear'
beforeEach(() => {
  vi.useFakeTimers()
  resetNativeChatPtySendQueuesForTests()
  io.write.mockReset().mockReturnValue(true)
  io.verified.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
})
it('observes a refused write, skips Enter, and releases the queue for the next user action', async () => {
  const rejected = vi.fn()
  io.verified.mockResolvedValueOnce(false)
  sendNativeChatMessage('pane', 'refused', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(rejected).toHaveBeenCalledOnce()
  expect(io.verified.mock.calls.map((call) => call[1])).toEqual([
    buildNativeChatPasteBytes('refused')
  ])
  sendNativeChatMessage('pane', 'next', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(io.verified.mock.calls.map((call) => call[1])).toEqual([
    buildNativeChatPasteBytes('refused'),
    buildNativeChatPasteBytes('next'),
    NATIVE_CHAT_SUBMIT
  ])
})
it('reports a lost acknowledgment once as unconfirmed, never as rejection, and still submits', async () => {
  const rejected = vi.fn()
  const unconfirmed = vi.fn()
  io.verified.mockRejectedValueOnce(new Error('lost acknowledgment'))
  io.verified.mockRejectedValueOnce(new Error('lost acknowledgment'))
  sendNativeChatMessage('pane', 'uncertain', {
    onWriteRejected: rejected,
    onWriteUnconfirmed: unconfirmed
  })
  await vi.advanceTimersByTimeAsync(120000)
  expect(rejected).not.toHaveBeenCalled()
  expect(unconfirmed).toHaveBeenCalledOnce()
  expect(io.verified.mock.calls.map((call) => call[1])).toEqual([
    buildNativeChatPasteBytes('uncertain'),
    NATIVE_CHAT_SUBMIT
  ])
})
it('serializes rapid sends through their acknowledged Enter and preserves the paste delay', async () => {
  const rejected = vi.fn()
  sendNativeChatMessage('pane', 'one', { onWriteRejected: rejected })
  sendNativeChatMessage('pane', 'two', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(499)
  expect(io.verified).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(501)
  expect(io.verified.mock.calls.map((call) => call[1])).toEqual([
    buildNativeChatPasteBytes('one'),
    NATIVE_CHAT_SUBMIT,
    buildNativeChatPasteBytes('two'),
    NATIVE_CHAT_SUBMIT
  ])
})

it.each(['accepted', 'refused', 'unknown'] as const)(
  'reports a pasted answer as acknowledged only after %s settlement',
  async (outcome) => {
    const settled = vi.fn()
    if (outcome === 'refused') {
      io.verified.mockResolvedValueOnce(false)
    } else if (outcome === 'unknown') {
      io.verified.mockRejectedValueOnce(new Error('lost acknowledgment'))
    }
    sendNativeChatMessage('pane', 'answer', { onDeliverySettled: settled })
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toHaveBeenCalledExactlyOnceWith(outcome === 'accepted')
    expect(io.verified.mock.calls.map((call) => call[1])).toEqual(
      outcome === 'refused'
        ? [buildNativeChatPasteBytes('answer')]
        : [buildNativeChatPasteBytes('answer'), NATIVE_CHAT_SUBMIT]
    )
  }
)

it('ignores a pasted answer acknowledgment after cancellation', async () => {
  let acknowledge: (accepted: boolean) => void = () => {}
  io.verified.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      acknowledge = resolve
    })
  )
  const settled = vi.fn()
  const handle = sendNativeChatMessage('pane', 'answer', { onDeliverySettled: settled })
  handle.cancel()
  acknowledge(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(settled).not.toHaveBeenCalled()
  expect(io.verified).toHaveBeenCalledOnce()
})

it.each([
  'text',
  'edited launch draft',
  'codex image only',
  'codex caption',
  'omp image only',
  'omp caption'
] as const)('preserves old/new %s bytes, order and delays', async (path) => {
  const traces: { bytes: string; at: number }[][] = []
  for (const observed of [false, true]) {
    resetNativeChatPtySendQueuesForTests()
    vi.setSystemTime(0)
    const trace: { bytes: string; at: number }[] = []
    io.write.mockImplementation((_pty, bytes: string) => {
      trace.push({ bytes, at: Date.now() })
      return true
    })
    io.verified.mockImplementation(async (_pty, bytes: string) => {
      trace.push({ bytes, at: Date.now() })
      return true
    })
    const options = {
      ...(path === 'edited launch draft'
        ? resolveNativeChatLaunchDraftSend({
            agent: 'codex',
            launchDraft: { agent: 'codex', text: 'original\nlaunch draft' },
            launchDraftResolved: false,
            readScreen: () => '› terminal-side edit\n  model · repo'
          }).sendOptions
        : {}),
      ...(observed ? { onWriteRejected: vi.fn() } : {})
    }
    const handle =
      path.includes('caption') || path.includes('image')
        ? sendNativeChatMessageWithImageAttachments(
            path.startsWith('omp') ? 'omp' : 'codex',
            'pane',
            path.includes('caption') ? 'caption' : '',
            ['/tmp/a.png', '/tmp/b.png'],
            options
          )
        : sendNativeChatMessage('pane', 'edited\ntext', options)
    await vi.advanceTimersByTimeAsync(2_000)
    await handle.settled
    traces.push(trace)
  }
  expect(traces[1]).toEqual(traces[0])
  const imageA = buildNativeChatImagePasteBytes(
    path.startsWith('omp') ? '@/tmp/a.png' : '/tmp/a.png'
  )
  const imageB = buildNativeChatImagePasteBytes(
    path.startsWith('omp') ? '@/tmp/b.png' : '/tmp/b.png'
  )
  const expected =
    path === 'edited launch draft'
      ? [
          buildAgentTuiClearInputForText('original\nlaunch draft'),
          AGENT_TUI_CLEAR_INPUT_MAX,
          buildNativeChatPasteBytes('edited\ntext')
        ]
      : path === 'text'
        ? ['\x15', buildNativeChatPasteBytes('edited\ntext')]
        : [
            '\x15',
            path.startsWith('omp') ? `${imageA} ` : imageA,
            path.includes('caption') ? `${imageB} ` : imageB,
            ...(path.includes('caption') ? ['caption'] : [])
          ]
  expect(traces[1]?.map((write) => write.bytes)).toEqual([...expected, NATIVE_CHAT_SUBMIT])
  const beforeSubmit = traces[1]?.at(-2)?.at
  const submittedAt = traces[1]?.at(-1)?.at
  expect(beforeSubmit).toBeDefined()
  expect(submittedAt).toBe((beforeSubmit ?? 0) + 500)
})

it.each(['refused', 'unknown'] as const)(
  'handles an image %s result without replay and releases the production queue',
  async (outcome) => {
    for (const frameIndex of [0, 1, 2, 3]) {
      resetNativeChatPtySendQueuesForTests()
      io.verified.mockReset().mockResolvedValue(true)
      const rejected = vi.fn()
      const unconfirmed = vi.fn()
      for (let index = 0; index < frameIndex; index++) {
        io.verified.mockResolvedValueOnce(true)
      }
      if (outcome === 'refused') {
        io.verified.mockResolvedValueOnce(false)
      } else {
        io.verified.mockRejectedValueOnce(new Error('image acknowledgment lost'))
      }
      const first = sendNativeChatMessageWithImageAttachments(
        'omp',
        'pane',
        'caption',
        ['/tmp/a.png', '/tmp/b.png'],
        { onWriteRejected: rejected, onWriteUnconfirmed: unconfirmed }
      )
      const next = sendNativeChatMessage('pane', 'next', { onWriteRejected: rejected })
      await vi.advanceTimersByTimeAsync(2_000)
      await Promise.all([first.settled, next.settled])
      expect(rejected).toHaveBeenCalledTimes(outcome === 'refused' ? 1 : 0)
      expect(unconfirmed).toHaveBeenCalledTimes(outcome === 'unknown' ? 1 : 0)
      const frames = [
        `${buildNativeChatImagePasteBytes('@/tmp/a.png')} `,
        `${buildNativeChatImagePasteBytes('@/tmp/b.png')} `,
        'caption',
        NATIVE_CHAT_SUBMIT
      ]
      expect(io.verified.mock.calls.map((call) => call[1])).toEqual([
        ...(outcome === 'refused' ? frames.slice(0, frameIndex + 1) : frames),
        buildNativeChatPasteBytes('next'),
        NATIVE_CHAT_SUBMIT
      ])
    }
  }
)
