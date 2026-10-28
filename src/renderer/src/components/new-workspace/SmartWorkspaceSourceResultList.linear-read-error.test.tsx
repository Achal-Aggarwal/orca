import { useStore } from 'zustand'
import { createTestStore } from '@/store/slices/linear-slice-test-harness'
import { clearLinearRequestMaps } from '@/store/slices/linear/linear-slice-request-state'
import {
  buildTaskSourceContextFromRepo,
  getTaskSourceCacheScope
} from '../../../../shared/task-source-context'
import { linearSearchCacheKey } from '@/store/slices/linear/linear-cache'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'
// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearConnectionStatus } from '../../../../shared/linear/workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import { WorkspaceAttachmentSourceStatus } from '../sidebar/WorkspaceAttachmentSourceStatus'
import { Command } from '@/components/ui/command'
import {
  referenceLinearIssue,
  referenceRepo
} from '../sidebar/workspace-reference-fixtures.test-support'
import { SmartWorkspaceSourceResultList } from './SmartWorkspaceSourceResultList'
import { useWorkItemSourceSearch } from './use-work-item-source-search'

const mocks = vi.hoisted(() => {
  // Host-wide status carries no error: the composer must show the read's own failure.
  const linearStatus: LinearConnectionStatus = {
    connected: true,
    viewer: null,
    selectedWorkspaceId: 'workspace-1'
  }
  return {
    state: {
      checkLinearConnection: vi.fn(),
      getCachedLinearIssues: vi.fn(),
      linearStatus,
      // The repo's own host: its status refresh reaches the composer's host-scoped read.
      linearStatusContextKey: 'runtime:env-1#0',
      linearStatusChecked: true,
      settings: null,
      preflightStatus: null,
      preflightStatusChecked: true,
      preflightStatusContextKey: 'test',
      refreshPreflightStatus: vi.fn(),
      searchLinearIssues: vi.fn<(query: string) => Promise<LinearIssue[]>>()
    }
  }
})
let pickerStore: ReturnType<typeof createTestStore>
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: Parameters<typeof pickerStore>[0]) => useStore(pickerStore, selector),
    {
      getState: () => pickerStore.getState(),
      subscribe: (...args: Parameters<typeof pickerStore.subscribe>) =>
        pickerStore.subscribe(...args)
    }
  )
}))
vi.mock('@/runtime/runtime-linear-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearStatus: async () => mocks.state.linearStatus,
  linearSearchIssues: (_settings: unknown, query: string) => mocks.state.searchLinearIssues(query)
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({}),
  localPreflightContextKey: () => 'test'
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./use-jira-source-connection', () => ({
  useJiraSourceConnection: () => ({ status: null, loaded: false })
}))
vi.mock('./use-jira-url-source', () => ({ useJiraUrlSource: () => ({ intent: false }) }))
vi.mock('../use-jira-project-inventory', () => ({
  useJiraProjectInventory: () => ({ projects: [], connected: true, error: null, loading: false })
}))

const repo: Repo = { ...referenceRepo, executionHostId: 'runtime:env-1' }
// Stable identity: search effects depend on the repos array.
const repos = [repo]
const onSelect = vi.fn()

function LinearPicker({
  value,
  attachment = false
}: {
  value: string
  attachment?: boolean
}): React.JSX.Element {
  const controller = useWorkItemSourceSearch({
    repos,
    selectedRepo: repo,
    repoId: repo.id,
    value,
    branchesEnabled: false,
    repoBackedSourcesDisabled: true
  })
  return (
    <Command>
      <button type="button" onClick={() => controller.setMode('linear')}>
        Linear tab
      </button>
      <button type="button" onClick={() => controller.setMode('smart')}>
        Smart tab
      </button>
      <SmartWorkspaceSourceResultList model={controller} onSelect={onSelect} />
      {attachment ? (
        <WorkspaceAttachmentSourceStatus
          controller={controller}
          taskUrlProvider="linear"
          resolved={false}
          error={null}
          onRetry={() => {}}
        />
      ) : null}
    </Command>
  )
}

describe('composer Linear read errors', () => {
  beforeEach(() => {
    mocks.state.linearStatus = {
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'workspace-1'
    }
    clearLinearRequestMaps()
    pickerStore = createTestStore()
    const { searchLinearIssues: _search, getCachedLinearIssues: _cache, ...initial } = mocks.state
    pickerStore.setState(initial)
    onSelect.mockClear()
    mocks.state.searchLinearIssues.mockReset()
    mocks.state.getCachedLinearIssues.mockReset()
    mocks.state.getCachedLinearIssues.mockReturnValue(null)
  })
  afterEach(() => {
    cleanup()
    clearLinearRequestMaps()
  })

  it.each([
    { cache: 'cold', attachment: false },
    { cache: 'warm', attachment: false },
    { cache: 'cold', attachment: true },
    { cache: 'warm', attachment: true }
  ])(
    '$cache network failure is safe with attachment=$attachment and successful retry clears it',
    async ({ cache, attachment }) => {
      if (cache === 'warm') {
        const context = buildTaskSourceContextFromRepo({
          provider: 'linear',
          projectId: repo.id,
          repo
        })!
        const key = `${getTaskSourceCacheScope(context)}::${linearSearchCacheKey('workspace-1', 'launch', RESULT_LIMIT)}`
        pickerStore.setState({
          linearSearchCache: { [key]: { data: [referenceLinearIssue()], fetchedAt: 1 } }
        })
      }
      mocks.state.searchLinearIssues.mockRejectedValue(new Error('private network diagnostic'))
      const { rerender } = render(<LinearPicker value="launch" attachment={attachment} />)
      fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
      const message = 'Unable to load Linear issues. Try again.'
      await waitFor(() => expect(screen.getAllByText(message)).toHaveLength(1))
      expect(screen.queryByText('Reconnect Linear')).toBeNull()
      if (cache === 'warm') {
        fireEvent.click(screen.getByText(/Task/))
        expect(onSelect).toHaveBeenCalledTimes(1)
      }
      fireEvent.click(screen.getByRole('button', { name: 'Smart tab' }))
      expect(screen.queryByText(message)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
      mocks.state.searchLinearIssues.mockResolvedValue([referenceLinearIssue()])
      rerender(<LinearPicker value="recovered" attachment={attachment} />)
      await waitFor(() => expect(screen.getByText(/Task/)).toBeTruthy())
      await waitFor(() => expect(screen.queryByText(message)).toBeNull())
    }
  )

  it('shows the read credential error on the Linear tab only, and a successful search clears it', async () => {
    mocks.state.searchLinearIssues.mockImplementation(async (query) => {
      if (query === 'broken') {
        throw new Error(credentialDecryptionMessage('Linear'))
      }
      return [referenceLinearIssue()]
    })
    const message = 'Reconnect Linear'
    const { rerender } = render(<LinearPicker value="broken" />)
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        `${message}Unable to read saved Linear login. Reconnect it in Settings.`
      )
    )

    // The status refresh after the failure re-runs the same read; the error must stay up.
    mocks.state.linearStatus = {
      ...mocks.state.linearStatus,
      credentialError: credentialDecryptionMessage('Linear')
    }
    rerender(<LinearPicker value="broken" />)
    expect(screen.getByText(message)).toBeTruthy()
    await waitFor(() => expect(mocks.state.searchLinearIssues).toHaveBeenCalled())
    expect(screen.getByText(message)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Smart tab' }))
    expect(screen.queryByText(message)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))

    rerender(<LinearPicker value="launch" />)
    await waitFor(() => expect(screen.getByText(/Task/)).toBeTruthy())
    expect(screen.queryByText(message)).toBeNull()
  })
})
