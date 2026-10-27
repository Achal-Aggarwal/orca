import { describe, expect, it, vi } from 'vitest'

import { dispatchTerminalWebViewNotification } from './terminal-webview-notification-dispatch'

describe('dispatchTerminalWebViewNotification', () => {
  it('preserves bounded keyboard metrics through the dispatcher', () => {
    const onKeyboardAvoidanceMetrics = vi.fn()
    dispatchTerminalWebViewNotification(
      {
        type: 'keyboard-avoidance-metrics',
        cursorY: 30,
        contentBottomRow: 99,
        rows: 40,
        altScreen: true
      },
      { onKeyboardAvoidanceMetrics, reportEngineError: vi.fn() },
      { current: 0 }
    )
    expect(onKeyboardAvoidanceMetrics).toHaveBeenCalledWith({
      cursorY: 30,
      contentBottomRow: 39,
      rows: 40,
      altScreen: true
    })
  })

  it('keeps old WebView payloads cursor-compatible', () => {
    const onKeyboardAvoidanceMetrics = vi.fn()
    dispatchTerminalWebViewNotification(
      { type: 'keyboard-avoidance-metrics', cursorY: 12, rows: 40 },
      { onKeyboardAvoidanceMetrics, reportEngineError: vi.fn() },
      { current: 0 }
    )
    expect(onKeyboardAvoidanceMetrics).toHaveBeenCalledWith({
      cursorY: 12,
      contentBottomRow: 12,
      rows: 40,
      altScreen: false
    })
  })

  it('passes a tap click on and keeps other terminal input bytes-only', () => {
    const onTerminalInput = vi.fn()
    const handlers = { onTerminalInput, reportEngineError: vi.fn() }
    const click = '\x1b[<0;9;31M\x1b[<0;9;31m'
    const wheel = '\x1b[<64;9;31M'
    dispatchTerminalWebViewNotification(
      { type: 'terminal-input', bytes: click, click: true },
      handlers,
      { current: 0 }
    )
    dispatchTerminalWebViewNotification({ type: 'terminal-input', bytes: wheel }, handlers, {
      current: 0
    })
    expect(onTerminalInput.mock.calls).toEqual([[click, { click: true }], [wheel]])
  })

  it('replays a withheld file tap only when no newer tap arrived', () => {
    const onTerminalInput = vi.fn()
    const onTerminalTap = vi.fn()
    const fallbacks: (() => void)[] = []
    const handlers = {
      onTerminalInput,
      onTerminalTap,
      onFileTap: (_candidates: unknown, onNoFile?: () => void) => fallbacks.push(onNoFile!),
      reportEngineError: vi.fn()
    }
    const interactions = { current: 0 }
    const fileTap = {
      type: 'terminal-file-tap',
      candidates: [{ pathText: '~/proj$ git' }],
      fallback: { clickInput: 'old-click', focus: true }
    }
    dispatchTerminalWebViewNotification(fileTap, handlers, interactions)
    dispatchTerminalWebViewNotification({ type: 'terminal-tap' }, handlers, interactions)
    fallbacks[0]()
    expect(onTerminalInput).not.toHaveBeenCalled()
    expect(onTerminalTap).toHaveBeenCalledTimes(1)

    dispatchTerminalWebViewNotification(fileTap, handlers, interactions)
    fallbacks[1]()
    expect(onTerminalInput).toHaveBeenCalledWith('old-click', { click: true })
    expect(onTerminalTap).toHaveBeenCalledTimes(2)
  })
})
