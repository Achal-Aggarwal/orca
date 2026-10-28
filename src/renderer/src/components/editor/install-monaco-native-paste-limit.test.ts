// @vitest-environment happy-dom
import { editor } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  installMonacoNativePasteLimit,
  registerMonacoNativePasteGuardOwner
} from './install-monaco-native-paste-limit'
import { MONACO_PASTE_MAX_BYTES } from './monaco-large-text-paste'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  vi.clearAllMocks()
})

function createEditor() {
  const node = document.createElement('div')
  const input = document.createElement('textarea')
  node.append(input)
  document.body.append(node)
  const disposed = new Set<() => void>()
  const state = { focused: true, readOnly: false }
  const instance = {
    getContainerDomNode: () => node,
    hasTextFocus: () => state.focused,
    getOption: () => state.readOnly,
    onDidDispose: (listener: () => void) => {
      disposed.add(listener)
      return { dispose: () => disposed.delete(listener) }
    }
  }
  const nativePaste = vi.fn((event: ClipboardEvent) => event.preventDefault())
  node.addEventListener('paste', nativePaste, { capture: true })
  return {
    instance,
    input,
    node,
    nativePaste,
    state,
    dispose: () => disposed.forEach((fn) => fn())
  }
}

function fixture() {
  const first = createEditor()
  type Instance = typeof first.instance
  const created = new Set<(instance: Instance) => void>()
  const cleanup = installMonacoNativePasteLimit(
    {
      getEditors: () => [first.instance],
      onDidCreateEditor: (listener) => {
        created.add(listener)
        return { dispose: () => created.delete(listener) }
      }
    },
    editor.EditorOption.readOnly
  )
  cleanups.push(cleanup)
  return {
    first,
    cleanup,
    created,
    create: () => {
      const next = createEditor()
      created.forEach((listener) => listener(next.instance))
      return next
    }
  }
}

function paste(target: HTMLElement, text: string): ClipboardEvent {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  data.setData('vscode-editor-data', '{"isFromEmptySelection":true}')
  const event = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: data
  })
  target.dispatchEvent(event)
  return event
}

it.each(['existing', 'created'] as const)(
  'rejects oversized native paste before the %s editor capture handler',
  (route) => {
    const f = fixture()
    const instance = route === 'existing' ? f.first : f.create()
    const event = paste(instance.input, 'x'.repeat(MONACO_PASTE_MAX_BYTES + 1))
    expect(event.defaultPrevented).toBe(true)
    expect(instance.nativePaste).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Paste is too large.')
  }
)

it('measures UTF-8 for multibyte payloads below the character cap', () => {
  const f = fixture()
  const text = '界'.repeat(Math.floor(MONACO_PASTE_MAX_BYTES / 3) + 1)
  expect(text.length).toBeLessThan(MONACO_PASTE_MAX_BYTES)
  paste(f.first.input, text)
  expect(f.first.nativePaste).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledExactlyOnceWith('Paste is too large.')
})

it.each(['ordinary', 'large', 'ascii-cap', 'multibyte-cap'] as const)(
  'preserves native ownership and metadata for admitted %s paste',
  (size) => {
    const f = fixture()
    const texts = {
      ordinary: 'native',
      large: 'x'.repeat(100_000),
      'ascii-cap': 'x'.repeat(MONACO_PASTE_MAX_BYTES),
      'multibyte-cap': `${'界'.repeat(Math.floor(MONACO_PASTE_MAX_BYTES / 3))}x`
    }
    const event = paste(f.first.input, texts[size])
    expect(f.first.nativePaste).toHaveBeenCalledExactlyOnceWith(event)
    expect(event.clipboardData?.getData('vscode-editor-data')).toBe('{"isFromEmptySelection":true}')
    expect(toast.error).not.toHaveBeenCalled()
  }
)

it.each(['read-only', 'widget-input', 'disposed', 'uninstalled'] as const)(
  'preserves the existing route for %s input and removes registrations',
  (mode) => {
    const f = fixture()
    if (mode === 'read-only') {
      f.first.state.readOnly = true
    }
    if (mode === 'widget-input') {
      f.first.state.focused = false
    }
    if (mode === 'disposed') {
      f.first.dispose()
    }
    if (mode === 'uninstalled') {
      f.cleanup()
      expect(f.created.size).toBe(0)
    }
    const event = paste(f.first.input, 'x'.repeat(MONACO_PASTE_MAX_BYTES + 1))
    expect(f.first.nativePaste).toHaveBeenCalledExactlyOnceWith(event)
    expect(toast.error).not.toHaveBeenCalled()
  }
)

it('leaves ordinary inputs outside every Monaco container alone', () => {
  fixture()
  const input = document.createElement('textarea')
  document.body.append(input)
  expect(paste(input, 'x'.repeat(MONACO_PASTE_MAX_BYTES + 1)).defaultPrevented).toBe(false)
  expect(toast.error).not.toHaveBeenCalled()
})

it('leaves clipboard reading to an explicit native guard owner and restores fallback on release', () => {
  const f = fixture()
  const release = registerMonacoNativePasteGuardOwner(f.first.instance)
  const text = 'x'.repeat(MONACO_PASTE_MAX_BYTES + 1)
  const data = new DataTransfer()
  data.setData('text/plain', text)
  const readClipboard = vi.spyOn(data, 'getData')
  const event = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: data
  })
  f.first.input.dispatchEvent(event)
  expect(f.first.nativePaste).toHaveBeenCalledExactlyOnceWith(event)
  expect(readClipboard).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  release()
  f.first.nativePaste.mockClear()
  paste(f.first.input, text)
  expect(f.first.nativePaste).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledExactlyOnceWith('Paste is too large.')
})

it('keeps a replacement native guard registration when its previous owner releases', () => {
  const f = fixture()
  const releasePrevious = registerMonacoNativePasteGuardOwner(f.first.instance)
  const releaseCurrent = registerMonacoNativePasteGuardOwner(f.first.instance)
  releasePrevious()
  paste(f.first.input, 'x'.repeat(MONACO_PASTE_MAX_BYTES + 1))
  expect(f.first.nativePaste).toHaveBeenCalledOnce()
  expect(toast.error).not.toHaveBeenCalled()
  releaseCurrent()
})
