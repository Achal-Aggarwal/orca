import { afterEach, expect, it } from 'vitest'
import type { DiffSection } from '../../diff-section-types'
import {
  claimCombinedDiffView,
  clearCombinedDiffViewMemory,
  forgetCombinedDiffViewsForWorktrees,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView,
  rememberCombinedDiffView
} from './combined-diff-view-cache'

function rememberView(index: number, section: Partial<DiffSection> = {}) {
  const lease = claimCombinedDiffView(`view-${index}`, 'workspace')
  const sections: DiffSection[] = [
    {
      key: 'unstaged:file.ts',
      path: 'file.ts',
      status: 'modified',
      area: 'unstaged',
      originalContent: 'base',
      modifiedContent: `draft-${index}`,
      collapsed: false,
      loading: false,
      dirty: false,
      diffResult: null,
      largeDiffRenderLimit: null,
      ...section
    }
  ]
  rememberCombinedDiffView(lease, {
    view: {
      entrySignature: 'one',
      gitStatusSignature: '',
      sections,
      sectionHeights: {},
      loadedIndices: [0],
      sideBySide: false
    }
  })
  return lease
}

afterEach(clearCombinedDiffViewMemory)

it.each([{ dirty: true }, { saveConflict: true as const }])(
  'retains every inactive draft owner beyond twenty views: %j',
  (state) => {
    for (let index = 0; index < 25; index++) {
      releaseCombinedDiffView(rememberView(index, state))
    }
    for (let index = 0; index < 25; index++) {
      expect(readCombinedDiffViewMemory(`view-${index}`)?.view?.sections[0]?.modifiedContent).toBe(
        `draft-${index}`
      )
    }
    const clean = rememberView(25)
    releaseCombinedDiffView(clean)
    expect(readCombinedDiffViewMemory('view-25')).toBeUndefined()
    forgetCombinedDiffViewsForWorktrees(['workspace'])
    expect(readCombinedDiffViewMemory('view-0')).toBeUndefined()
  }
)

it('protects mounted clean views until the final lease releases and then prunes reloadable history', () => {
  const leases = Array.from({ length: 22 }, (_, index) => rememberView(index))
  const extraLease = claimCombinedDiffView('view-0', 'workspace')
  for (let index = 0; index < 22; index++) {
    expect(readCombinedDiffViewMemory(`view-${index}`)).toBeDefined()
  }
  releaseCombinedDiffView(leases[0]!)
  expect(readCombinedDiffViewMemory('view-0')).toBeDefined()
  releaseCombinedDiffView(extraLease)
  expect(readCombinedDiffViewMemory('view-0')).toBeUndefined()
  releaseCombinedDiffView(leases[1]!)
  expect(readCombinedDiffViewMemory('view-1')).toBeUndefined()
  expect(readCombinedDiffViewMemory('view-2')).toBeDefined()
})

it('makes a saved draft eligible again after unmount', () => {
  const leases = Array.from({ length: 21 }, (_, index) => rememberView(index, { dirty: true }))
  for (const lease of leases) {
    releaseCombinedDiffView(lease)
  }
  const saved = claimCombinedDiffView('view-0', 'workspace')
  const view = readCombinedDiffViewMemory('view-0')?.view
  expect(view).toBeDefined()
  if (!view) {
    throw new Error('missing edited view')
  }
  rememberCombinedDiffView(saved, {
    view: { ...view, sections: view.sections.map((section) => ({ ...section, dirty: false })) }
  })
  expect(readCombinedDiffViewMemory('view-0')).toBeDefined()
  releaseCombinedDiffView(saved)
  expect(readCombinedDiffViewMemory('view-0')).toBeUndefined()
  expect(readCombinedDiffViewMemory('view-1')?.view?.sections[0]?.dirty).toBe(true)
})

it('keeps only twenty reloadable clean views in LRU order', () => {
  for (let index = 0; index < 22; index++) {
    releaseCombinedDiffView(rememberView(index))
  }
  expect(readCombinedDiffViewMemory('view-0')).toBeUndefined()
  expect(readCombinedDiffViewMemory('view-1')).toBeUndefined()
  expect(readCombinedDiffViewMemory('view-2')).toBeDefined()
  expect(readCombinedDiffViewMemory('view-21')).toBeDefined()
})
