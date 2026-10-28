import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as AgentNameTokenMatchModule from './agent-name-token-match'
import { getAgentLabel } from './agent-title-identity'
import { detectAgentStatusFromTitle } from './agent-title-status'
import { memoizeTitleClassification } from './terminal-title-classification-memo'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'
import * as Evidence from './agent-title-evidence'
import * as Frames from './agent-title-name-anchoring'
import { createTerminalTitleTracker } from './terminal-output-side-effects'
import { resolveTabAgentFromSignalSnapshot } from './tab-agent-from-signals'
import { buildTitleDerivedAgentRows } from '../renderer/src/components/sidebar/worktree-title-derived-agent-rows'
import type { TerminalTab } from './terminal-tab-types'

vi.mock('./agent-title-evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof Evidence>()
  return {
    ...actual,
    collectExplicitAgentTitleEvidence: vi.fn(actual.collectExplicitAgentTitleEvidence)
  }
})
vi.mock('./agent-title-name-anchoring', async (importOriginal) => {
  const actual = await importOriginal<typeof Frames>()
  return { ...actual, agentForNativeFrame: vi.fn(actual.agentForNativeFrame) }
})

// Count the leaf titleHasAgentName regex to measure unchanged-title work across store writes.
vi.mock('./agent-name-token-match', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentNameTokenMatchModule>()
  return { ...actual, titleHasAgentName: vi.fn(actual.titleHasAgentName) }
})

const classifierCalls = vi.mocked(AgentNameTokenMatchModule.titleHasAgentName)

// Titles a real sidebar holds steady while unrelated agent-status writes churn.
const UNCHANGED_TITLES = [
  'codex working',
  'opencode-blinker',
  'zsh',
  '✳ Claude Code',
  'copilot.exe - action required',
  'gemini',
  'cursor agent'
]
const STORE_WRITES = 50

function classifyEveryTitle(): void {
  for (const title of UNCHANGED_TITLES) {
    getAgentLabel(title)
    detectAgentStatusFromTitle(title)
    resolveExplicitTerminalTitleAgentType(title)
  }
}

describe('terminal title classification memo', () => {
  beforeEach(() => {
    classifierCalls.mockClear()
  })

  it('classifies each distinct title once across repeated store writes', () => {
    // Warm the caches the way the first render would, then measure steady state.
    classifyEveryTitle()
    classifierCalls.mockClear()

    for (let write = 0; write < STORE_WRITES; write += 1) {
      classifyEveryTitle()
    }

    // Without memoization this fixture makes 4350 leaf matches; steady-state unchanged titles should make none.
    expect(classifierCalls).not.toHaveBeenCalled()
  })

  it('reclassifies as soon as the title changes', () => {
    expect(getAgentLabel('codex ready')).toBe('Codex')
    expect(getAgentLabel('grok ready')).toBe('Grok')
    expect(detectAgentStatusFromTitle('codex ready')).toBe('idle')
    expect(detectAgentStatusFromTitle('codex working')).toBe('working')
  })

  it('bounds cold OSC work at N/10N and does zero new classification on unchanged production projections', () => {
    const strict = vi.mocked(Evidence.collectExplicitAgentTitleEvidence)
    const frames = vi.mocked(Frames.agentForNativeFrame)
    const clear = () => {
      strict.mockClear()
      frames.mockClear()
      classifierCalls.mockClear()
    }
    const counts = () => [
      strict.mock.calls.length,
      frames.mock.calls.length + classifierCalls.mock.calls.length
    ]
    const measure = (population: number) => {
      const leafId = '77777777-7777-4777-8777-777777777777'
      const tabs: TerminalTab[] = Array.from({ length: population }, (_, index) => ({
        id: `tab-${index}`,
        worktreeId: 'memo',
        ptyId: `pty-${index}`,
        title: '',
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 0,
        launchAgent: 'claude'
      }))
      const trackers = tabs.map((tab) =>
        createTerminalTitleTracker({
          onTitle: (title) => {
            tab.title = title
          }
        })
      )
      const project = () => {
        const icons = tabs.map((tab) =>
          resolveTabAgentFromSignalSnapshot({
            title: tab.title,
            hookAgent: null,
            focusedCompletedHookAgent: 'claude',
            launchAgent: 'claude'
          })
        )
        const rows = buildTitleDerivedAgentRows({
          tabs,
          ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, [tab.ptyId!]])),
          terminalLayoutsByTabId: Object.fromEntries(
            tabs.map((tab) => [
              tab.id,
              { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
            ])
          ),
          seenPaneKeys: new Set(),
          now: 1
        })
        return { icons, rows }
      }
      try {
        clear()
        trackers.forEach((tracker, index) =>
          tracker.handleChunk(
            `\x1b]0;⠋ Codex: memo-${String(population).padStart(3, '0')}-${String(index).padStart(3, '0')}\x07`
          )
        )
        const first = project()
        expect(first.icons).toEqual(Array(population).fill('codex'))
        expect(first.rows.map((row) => [row.agentType, row.entry.prompt])).toEqual(
          Array.from({ length: population }, () => ['codex', 'Codex'])
        )
        const cold = counts()
        clear()
        for (let write = 0; write < STORE_WRITES; write += 1) {
          project()
        }
        expect(counts()).toEqual([0, 0])
        trackers[0].handleChunk(
          `\x1b]0;Fix Codex memo-${String(population).padStart(3, '0')} - grok\x07`
        )
        const changed = project()
        expect(changed.icons[0]).toBe('grok')
        expect(changed.rows[0]).toMatchObject({ agentType: 'grok', entry: { prompt: 'Grok' } })
        expect(changed.icons.slice(1)).toEqual(Array(population - 1).fill('codex'))
        return { cold, changed: counts() }
      } finally {
        trackers.forEach((tracker) => tracker.dispose())
      }
    }
    const n = measure(10)
    const tenN = measure(100)
    expect(n.cold[0]).toBe(10)
    expect(tenN.cold[0]).toBe(100)
    expect(tenN.cold[1]).toBeLessThanOrEqual(n.cold[1] * 10)
    expect(n.cold[1]).toBeGreaterThan(0)
    expect(tenN.changed).toEqual(n.changed)
    expect(n.changed[0]).toBe(1)
  })

  it('caches null and false verdicts, not just truthy ones', () => {
    const classify = vi.fn((): string | null => null)
    const memoized = memoizeTitleClassification(classify)
    expect(memoized('zsh')).toBeNull()
    expect(memoized('zsh')).toBeNull()
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it('evicts oldest entries instead of growing without bound', () => {
    const classify = vi.fn((title: string) => title.length)
    const memoized = memoizeTitleClassification(classify)
    for (let index = 0; index < 1030; index += 1) {
      memoized(`title-${index}`)
    }
    const afterFill = classify.mock.calls.length
    memoized('title-1029')
    expect(classify.mock.calls.length).toBe(afterFill)
    memoized('title-0')
    expect(classify.mock.calls.length).toBe(afterFill + 1)
  })
})
