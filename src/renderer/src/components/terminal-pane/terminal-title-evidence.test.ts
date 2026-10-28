import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalTitleTracker,
  STALE_WORKING_TITLE_TIMEOUT_MS,
  type TerminalTitleFactMeta
} from '../../../../shared/terminal-output-side-effects'
import { resolvePaneTitleDecision } from './terminal-title-evidence'
import { installTitleSpawnBell } from './pty-connection/title-spawn-bell'
import { clearStaleAgentTabTitleOnConfirmedShell } from './pty-connection/confirmed-shell-agent-title'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { terminalGpuAcceleration: 'auto' },
      agentStatusByPaneKey: {},
      runtimePaneTitlesByTabId: { tab: { 1: 'fix the gemini launcher' } },
      tabsByWorktree: {}
    })
  }
}))
vi.mock('./pty-connection/pane-pty-visibility-bind', () => ({
  installPanePtyVisibilityBind: vi.fn()
}))

describe('resolvePaneTitleDecision', () => {
  it.each([
    ['✦ Gemini CLI', '⠋ fix the gemini launcher', '⠋ fix the gemini launcher'],
    ['◇ Gemini CLI', '⠋ add ✦ icon to header', '⠋ add ✦ icon to header'],
    [
      '✋ Gemini CLI',
      '⠋ Codex: fix Gemini terminal behavior',
      '⠋ Codex: fix Gemini terminal behavior'
    ],
    ['✦ Gemini CLI', '✦ Analyze Codex', '✦ Gemini CLI'],
    // Normalized-only history cannot recover the original task; title-only reuse remains supported.
    ['✦ Gemini CLI', '✦ Gemini CLI', '✦ Gemini CLI']
  ])(
    'corrects only disproved old Gemini stamps (%s, %s)',
    (normalizedTitle, rawTitle, displayTitle) => {
      const decision = resolvePaneTitleDecision({
        normalizedTitle,
        rawTitle,
        displayOwnerAgentType: 'claude',
        rendererOwnerAgentType: null,
        userGpuMode: 'auto'
      })
      expect(decision.displayTitle).toBe(displayTitle)
      expect(decision.rawTitle).toBe(rawTitle)
    }
  )

  it('keeps current timer facts cleared with equal raw/display input and existing provenance', async () => {
    vi.useFakeTimers()
    const facts: [string, string, unknown][] = []
    const startup = vi.fn()
    const completion = vi.fn()
    const session = {
      cacheKey: 'tab:leaf',
      pane: { id: 1 },
      deps: {
        tabId: 'tab',
        worktreeId: 'wt',
        setRuntimePaneTitle: vi.fn(),
        updateTabTitle: vi.fn()
      },
      manager: { getActivePane: () => ({ id: 1 }), setPaneGpuRendering: vi.fn() },
      getAuthoritativePaneAgent: () => 'claude',
      getPaneScopedRendererOwner: () => 'claude',
      syncAgentTaskCompleteTrackingEnabled: () => true,
      shouldSuppressTitleCompletionForFreshHook: () => false,
      paneForegroundAgentTracker: { onAgentStartupObserved: startup },
      agentCompletionCoordinator: { observeTitle: completion },
      hasConsideredInitialCacheTimerSeed: true,
      neutralTerminalTitle: () => 'Terminal 1',
      releaseCommandCodeDoneSettleExecutor: () => {},
      onTitleChange: (_title: string, _raw: string, _meta?: TerminalTitleFactMeta) => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the installed title callback runs; its session dependencies are supplied above.
    installTitleSpawnBell(session as never)
    const tracker = createTerminalTitleTracker({
      onTitle: (title, raw, meta) => {
        facts.push([title, raw, meta])
        session.onTitleChange(title, raw, meta)
      }
    })
    try {
      tracker.handleChunk('\x1b]0;⠋ fix the gemini launcher\x07')
      tracker.handleChunk('more output\n')
      await vi.advanceTimersByTimeAsync(STALE_WORKING_TITLE_TIMEOUT_MS)
      expect(facts).toEqual([
        ['⠋ fix the gemini launcher', '⠋ fix the gemini launcher', undefined],
        ['fix the gemini launcher', 'fix the gemini launcher', { staleWorkingTitleClear: true }]
      ])
      expect(startup).not.toHaveBeenCalled()
      expect(completion).toHaveBeenCalledExactlyOnceWith('⠋ fix the gemini launcher')
      expect(session.deps.updateTabTitle).toHaveBeenLastCalledWith('tab', 'fix the gemini launcher')
      const [normalizedTitle, rawTitle] = facts[1]
      expect(
        resolvePaneTitleDecision({
          normalizedTitle,
          rawTitle,
          displayOwnerAgentType: 'claude',
          rendererOwnerAgentType: null,
          userGpuMode: 'auto'
        }).displayTitle
      ).toBe('fix the gemini launcher')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reset reads only pane/deps/manager/default-title fields supplied above.
      clearStaleAgentTabTitleOnConfirmedShell(session as never)
      expect(session.deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab', 1, 'Terminal 1')
      expect(session.deps.updateTabTitle).toHaveBeenLastCalledWith('tab', 'Terminal 1')
    } finally {
      tracker.dispose()
      session.releaseCommandCodeDoneSettleExecutor()
      vi.useRealTimers()
    }
  })
  it('derives the display label and the renderer veto from a pane-scoped OMP owner', () => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle: 'Pi ready',
      rawTitle: '✦ Gemini CLI',
      displayOwnerAgentType: 'omp',
      rendererOwnerAgentType: 'omp',
      userGpuMode: 'auto'
    })
    expect(decision.displayTitle).toBe('OMP ready')
    expect(decision.rawTitle).toBe('✦ Gemini CLI')
    // Why: the OMP owner renames the label and vetoes the Gemini glyph fallback.
    expect(decision.rendererPolicy.gpuEnabled).toBe(true)
  })

  it('uses the renderer owner, not the display owner, for the GPU veto', () => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle: 'Pi ready',
      rawTitle: '✦ Gemini CLI',
      // Sticky ownership labels the tab, but only current pane ownership can veto Gemini’s DOM fallback.
      displayOwnerAgentType: 'omp',
      rendererOwnerAgentType: undefined,
      userGpuMode: 'auto'
    })
    expect(decision.displayTitle).toBe('OMP ready')
    expect(decision.rendererPolicy.gpuEnabled).toBe(false)
    expect(decision.rendererPolicy.reason).toBe('agent-compatibility')
  })
})
