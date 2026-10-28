// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, REPO_ID, WORKSPACE_ID } from './automations-page-fixtures'
import { listedRows } from './automations-page-listed-items'

const DESKTOP_SELF_FILTER = {
  kind: 'host' as const,
  host: { authority: { kind: 'desktop' as const }, selector: { kind: 'self' as const } }
}
const CREATED = makeAutomation({ id: 'a-new', name: 'Sweep' })

describe('automation prompt drain save transaction', () => {
  installAutomationsPageHarness()
  for (const mode of ['create', 'edit'] as const) {
    it(`uses the synchronously drained prompt in the same ${mode} transaction`, async () => {
      api.automations.list.mockResolvedValue([CREATED])
      scopedList([CREATED])
      mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
      api.automations.create.mockResolvedValue(CREATED)
      api.automations.update.mockResolvedValue(CREATED)
      await renderPage()
      await settleHostQueries()
      await act(async () => {
        if (mode === 'create') {
          mocks.listPanel?.openCreateDialog()
        } else {
          const row = listedRows()[0]
          if (!row) {
            throw new Error('Missing automation row')
          }
          mocks.listPanel?.openEditDialog(row)
        }
      })
      await settleHostQueries()
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => {
          if (typeof current !== 'object' || current === null) {
            throw new Error('Missing automation draft')
          }
          return {
            ...current,
            name: 'Sweep',
            prompt: 'before paste',
            projectId: REPO_ID,
            workspaceMode: 'existing',
            workspaceId: WORKSPACE_ID
          }
        })
      })
      const dialog = mocks.editorDialog
      await act(async () => {
        dialog?.onDraftChange((current) => {
          if (typeof current !== 'object' || current === null) {
            throw new Error('Missing automation draft')
          }
          return { ...current, prompt: 'before paste plus accepted prefix' }
        })
        dialog?.onSave()
      })
      await settleHostQueries()
      const request = mode === 'create' ? api.automations.create : api.automations.update
      expect(request).toHaveBeenCalledOnce()
      expect(request.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining(
          mode === 'create'
            ? { prompt: 'before paste plus accepted prefix' }
            : { updates: expect.objectContaining({ prompt: 'before paste plus accepted prefix' }) }
        )
      )
    })
  }
})
