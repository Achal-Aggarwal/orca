// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  refreshOnFocus,
  renderPage,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, WORKSPACE_ID } from './automations-page-fixtures'
import { listedRow } from './automations-page-listed-items'

async function changePrompt(prompt: string): Promise<void> {
  await act(async () => {
    mocks.editorDialog?.onDraftChange((current) => {
      if (typeof current !== 'object' || current === null) {
        throw new Error('Missing automation draft')
      }
      return { ...current, prompt }
    })
  })
  await settleHostQueries()
}

describe('automation draft comparison admission', () => {
  installAutomationsPageHarness()

  for (const units of [81920, 819200]) {
    it(`avoids serializing the unchanged ${units}-unit prompt during page refreshes`, async () => {
      const prompt = 'x'.repeat(units)
      const automation = makeAutomation({
        prompt,
        workspaceMode: 'existing',
        workspaceId: WORKSPACE_ID
      })
      mocks.state.automationHostFilter = {
        kind: 'host',
        host: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
      }
      api.automations.list.mockResolvedValue([automation])
      scopedList([automation])
      await renderPage()
      await settleHostQueries()
      await act(async () => mocks.listPanel?.openEditDialog(listedRow(automation.id)))
      await settleHostQueries()
      expect(mocks.editorDialog?.canSave).toBe(false)

      for (const phase of ['pristine', 'edited', 'reverted', 'closed'] as const) {
        if (phase === 'edited' || phase === 'reverted') {
          await changePrompt(phase === 'edited' ? `${prompt}-edit` : prompt)
        }
        if (phase === 'closed') {
          await act(async () => mocks.editorDialog?.onOpenChange(false))
        }
        expect(mocks.editorDialog?.canSave).toBe(phase === 'edited')
        const draft = mocks.editorDialog?.draft
        const readsBefore = api.automations.list.mock.calls.length
        const stringify = vi.spyOn(JSON, 'stringify')
        try {
          for (let update = 0; update < 3; update += 1) {
            await refreshOnFocus()
            await settleHostQueries()
          }
          const serializedPrompts = stringify.mock.calls.flatMap(([value]) =>
            typeof value === 'object' &&
            value !== null &&
            'savedSchedule' in value &&
            'prompt' in value &&
            typeof value.prompt === 'string'
              ? [value.prompt.length]
              : []
          )
          console.info('AUTOMATION_DRAFT_SERIALIZATION', {
            units,
            phase,
            refreshes: 3,
            serializations: serializedPrompts.length,
            promptUnits: serializedPrompts.reduce((total, length) => total + length, 0)
          })
          expect(api.automations.list.mock.calls.length).toBeGreaterThanOrEqual(readsBefore + 3)
          expect(mocks.editorDialog?.draft).toBe(draft)
          expect(mocks.editorDialog?.canSave).toBe(phase === 'edited')
          expect.soft(serializedPrompts).toHaveLength(0)
        } finally {
          stringify.mockRestore()
        }
      }
    })
  }

  it('keeps create mode available and resets the comparison baseline on reopen', async () => {
    const automation = makeAutomation({ workspaceMode: 'existing', workspaceId: WORKSPACE_ID })
    mocks.state.automationHostFilter = {
      kind: 'host',
      host: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
    }
    api.automations.list.mockResolvedValue([automation])
    scopedList([automation])
    await renderPage()
    await settleHostQueries()
    await act(async () => mocks.listPanel?.openCreateDialog())
    expect(mocks.editorDialog?.canSave).toBe(true)
    await act(async () => mocks.listPanel?.openEditDialog(listedRow(automation.id)))
    await settleHostQueries()
    expect(mocks.editorDialog?.canSave).toBe(false)
    await changePrompt('changed')
    expect(mocks.editorDialog?.canSave).toBe(true)
    await act(async () => mocks.listPanel?.openEditDialog(listedRow(automation.id)))
    await settleHostQueries()
    expect(mocks.editorDialog?.canSave).toBe(false)
  })

  it('compares primitive edits without serializing and equates absent optional setup decisions', async () => {
    const automation = makeAutomation({ workspaceMode: 'existing', workspaceId: WORKSPACE_ID })
    mocks.state.automationHostFilter = {
      kind: 'host',
      host: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
    }
    api.automations.list.mockResolvedValue([automation])
    scopedList([automation])
    await renderPage()
    await settleHostQueries()
    await act(async () => mocks.listPanel?.openEditDialog(listedRow(automation.id)))
    await settleHostQueries()
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => {
          if (typeof current !== 'object' || current === null || !('setupDecision' in current)) {
            throw new Error('Missing automation draft')
          }
          const { setupDecision: _setupDecision, ...remaining } = current
          return remaining
        })
      })
      expect(mocks.editorDialog?.canSave).toBe(false)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => {
          if (typeof current !== 'object' || current === null) {
            throw new Error('Missing automation draft')
          }
          return { ...current, setupDecision: undefined, name: 'Changed name' }
        })
      })
      expect(mocks.editorDialog?.canSave).toBe(true)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => {
          if (typeof current !== 'object' || current === null) {
            throw new Error('Missing automation draft')
          }
          return { ...current, name: automation.name }
        })
      })
      expect(mocks.editorDialog?.canSave).toBe(false)
      await changePrompt('Changed prompt')
      expect(mocks.editorDialog?.canSave).toBe(true)
      await changePrompt(automation.prompt)
      expect(mocks.editorDialog?.canSave).toBe(false)
      expect(
        stringify.mock.calls.filter(
          ([value]) => typeof value === 'object' && value !== null && 'savedSchedule' in value
        )
      ).toHaveLength(0)
    } finally {
      stringify.mockRestore()
    }
  })
})
