// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPrCommentCodeContext } from '@/components/github/pr-comment-code-context'
import { useMonacoColorizedLines } from '@/components/editor/MonacoCodeExcerpt'

const state = vi.hoisted(() => {
  let releaseLanguage = (): void => {}
  const languageReady = new Promise<void>((resolve) => {
    releaseLanguage = resolve
  })
  return {
    dark: false,
    colorize: vi.fn(async (code: string) => code.replaceAll('\n', '<br/>') + '<br/>'),
    languageReady,
    releaseLanguage
  }
})

vi.mock('@/store', () => ({ useAppStore: vi.fn() }))
vi.mock('@/hooks/use-document-dark-theme', () => ({
  useDocumentDarkTheme: () => state.dark
}))
vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    editor: { colorize: state.colorize, setTheme: vi.fn() },
    languages: {
      getLanguages: () => [],
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    }
  }
}))
vi.mock('monaco-editor/esm/vs/basic-languages/python/python.js', async () => {
  await state.languageReady
  return { conf: {}, language: {} }
})

const source = ['const first = 1', 'const second = 2'].join('\n')

function reviewLines(): string[] {
  const context = getPrCommentCodeContext({
    source,
    line: 1,
    startLine: 1,
    contextBefore: 0,
    contextAfter: 1,
    fallbackLines: 20,
    maxBlockLines: 41
  })
  if (!context) {
    throw new Error('Missing review context')
  }
  return context.selectedLines
}

async function settle(): Promise<void> {
  await act(async () => {})
}

beforeEach(() => {
  state.dark = false
  state.colorize.mockClear()
})

afterEach(cleanup)

describe('excerpt colorization work', () => {
  it.each([10, 100])('reuses unchanged text over %i review context renders', async (renders) => {
    const view = renderHook(({ lines }) => useMonacoColorizedLines(lines, 'typescript'), {
      initialProps: { lines: reviewLines() }
    })
    await settle()
    for (let index = 0; index < renders; index += 1) {
      view.rerender({ lines: reviewLines() })
      await settle()
    }
    expect(view.result.current).toEqual(source.split('\n'))
    expect(state.colorize).toHaveBeenCalledTimes(1)
  })

  it('recolorizes content, language and theme changes, including blank and empty input', async () => {
    const view = renderHook(({ lines, language }) => useMonacoColorizedLines(lines, language), {
      initialProps: { lines: ['first'], language: 'typescript' }
    })
    await settle()
    view.rerender({ lines: ['second', ''], language: 'typescript' })
    await settle()
    expect(view.result.current).toEqual(['second', ''])
    view.rerender({ lines: ['second', ''], language: 'javascript' })
    await settle()
    state.dark = true
    view.rerender({ lines: ['second', ''], language: 'javascript' })
    await settle()
    expect(state.colorize).toHaveBeenCalledTimes(4)
    view.rerender({ lines: [], language: 'javascript' })
    await settle()
    expect(view.result.current).toEqual([])
    view.rerender({ lines: [''], language: 'javascript' })
    await settle()
    expect(view.result.current).toEqual([''])
    expect(state.colorize).toHaveBeenCalledTimes(5)
  })

  it('keeps the latest result when an already running colorization finishes late', async () => {
    let finishStale = (_html: string): void => {}
    const staleResult = new Promise<string>((resolve) => {
      finishStale = resolve
    })
    state.colorize.mockImplementationOnce(() => staleResult)
    const view = renderHook(({ lines }) => useMonacoColorizedLines(lines, 'typescript'), {
      initialProps: { lines: ['old'] }
    })
    await settle()
    view.rerender({ lines: ['new'] })
    await settle()
    expect(view.result.current).toEqual(['new'])
    await act(async () => finishStale('old<br/>'))
    expect(view.result.current).toEqual(['new'])
  })

  it('does not tokenize replaced or unmounted Python excerpts after their language loads', async () => {
    const abandoned = renderHook(({ lines }) => useMonacoColorizedLines(lines, 'python'), {
      initialProps: { lines: ['print(0)'] }
    })
    for (let index = 1; index <= 10; index += 1) {
      abandoned.rerender({ lines: [`print(${index})`] })
    }
    abandoned.unmount()
    const liveLines = ['print("live")']
    const live = renderHook(() => useMonacoColorizedLines(liveLines, 'python'))
    expect(state.colorize).not.toHaveBeenCalled()
    await act(async () => state.releaseLanguage())
    await settle()
    expect(live.result.current).toEqual(['print("live")'])
    expect(state.colorize).toHaveBeenCalledTimes(1)
    expect(state.colorize).toHaveBeenLastCalledWith('print("live")', 'python', { tabSize: 2 })
  })
})
