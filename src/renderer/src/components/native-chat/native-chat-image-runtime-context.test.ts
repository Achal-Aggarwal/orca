import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../shared/tab-types'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import {
  resolveNativeChatImageRuntimeContext,
  selectNativeChatImageOwnerState
} from './native-chat-image-runtime-context'
import { repoFixture, worktreeFixture } from './native-chat-workspace-test-fixtures'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../sidebar/folder-workspace-composer-submit-fixtures'
import { resolveNativeChatFileLinkContext } from './native-chat-file-link'
import {
  resolveNativeChatSkillDiscoveryContext,
  selectNativeChatSkillStateInputs
} from './native-chat-skill-discovery-context'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { captureWorktreeSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { adoptFromEndpoint } from '@/store/adopt-from-endpoint'
import { assertRuntimeFileMutationExpectation } from '../../../../main/runtime/files/file-mutation-expectation'
import {
  resetSshConnectionGenerations,
  setSshConnectionGeneration
} from '../../../../main/ssh/connection/ssh-connection-generation'

function state(overrides: Partial<AppState> = {}): AppState {
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const worktree = worktreeFixture('wt-1', '/repo/worktree', { hostId: 'local' })
  return {
    ...useAppStore.getInitialState(),
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: 'wt-1',
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    getKnownWorktreeById: () => worktree,
    projectGroups: [],
    removedRuntimeEnvironmentIds: new Set(),
    repos: [repoFixture()],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [],
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    tabsByWorktree: { 'wt-1': [tab] },
    unifiedTabsByWorktree: {},
    worktreesByRepo: { repo: [worktree] },
    ...overrides
  }
}

describe('resolveNativeChatImageRuntimeContext', () => {
  it.each(['inherited', 'adopted'] as const)(
    'retains a paired folder target through real file, image, skill and write contexts: %s',
    (shape) => {
      const target = { kind: 'environment', environmentId: 'owner-a' } as const
      const original = makeFolderWorkspace({
        id: 'paired-folder',
        projectGroupId: 'paired-project',
        folderPath: '/remote/folder',
        connectionId: 'box'
      })
      const folder =
        shape === 'adopted'
          ? adoptFromEndpoint(target, {
              kind: 'folderWorkspace',
              row: original,
              resolveOwnHostId: () => 'ssh:box'
            })
          : { ...original, connectionId: null }
      const workspaceId = `folder:${folder.id}`
      const snapshot = state({
        activeWorktreeId: workspaceId,
        activeWorkspaceExecutionHostId: 'runtime:owner-a',
        folderWorkspaces: [folder],
        projectGroups: [
          adoptFromEndpoint(target, {
            kind: 'projectGroup',
            row: {
              ...makeProjectGroup(),
              id: 'paired-project',
              executionHostId: 'ssh:box',
              connectionId: 'box'
            }
          })
        ],
        repos: [],
        worktreesByRepo: {},
        tabsByWorktree: {
          [workspaceId]: [{ ...state().tabsByWorktree['wt-1'][0], worktreeId: workspaceId }]
        },
        runtimeEnvironments: [],
        sshStateByEnvironment: new Map([
          [
            'owner-a',
            {
              targetsHydrated: true,
              targetLabels: new Map([['box', 'Server box']]),
              targetGenerations: new Map([['box', 7]]),
              removedTargetLabels: new Map(),
              connectionStates: new Map([
                [
                  'box',
                  {
                    targetId: 'box',
                    status: 'connected',
                    error: null,
                    reconnectAttempt: 0,
                    connectionGeneration: 7
                  }
                ]
              ])
            }
          ]
        ])
      })
      expect.soft(resolveNativeChatFileLinkContext(snapshot, 'tab-1')).toMatchObject({
        worktreeId: workspaceId,
        worktreePath: '/remote/folder',
        runtimeEnvironmentId: 'owner-a'
      })
      expect
        .soft(
          resolveNativeChatImageRuntimeContext(selectNativeChatImageOwnerState(snapshot), 'tab-1')
        )
        .toMatchObject({
          target: { kind: 'environment', environmentId: 'owner-a' },
          worktreePath: '/remote/folder',
          expectedExecutionHostId: 'ssh:box',
          expectedSshConnectionGeneration: 7
        })
      expect
        .soft(
          resolveNativeChatSkillDiscoveryContext(
            selectNativeChatSkillStateInputs(snapshot),
            'tab-1'
          )
        )
        .toMatchObject({
          cwd: '/remote/folder',
          runtimeTarget: { kind: 'environment', environmentId: 'owner-a' },
          discoveryTarget: { worktreeId: workspaceId }
        })
      const editor = getEditorFileOperationContext(
        snapshot,
        { worktreeId: workspaceId },
        '/remote/folder'
      )
      expect.soft(editor).toMatchObject({
        target: { kind: 'environment', environmentId: 'owner-a' },
        expectedExecutionHostId: 'ssh:box',
        expectedSshConnectionGeneration: 7
      })
      resetSshConnectionGenerations()
      setSshConnectionGeneration('box', 7)
      expect
        .soft(() =>
          assertRuntimeFileMutationExpectation(
            'ssh:box',
            editor.expectedExecutionHostId,
            editor.expectedSshTargetId,
            editor.expectedSshConnectionGeneration
          )
        )
        .not.toThrow()
      resetSshConnectionGenerations()
      expect.soft(captureWorktreeSshMutationExpectation(snapshot, workspaceId)).toEqual({
        expectedExecutionHostId: 'ssh:box',
        expectedSshTargetId: 'box',
        expectedSshConnectionGeneration: 7
      })
    }
  )

  it('keeps unrelated store writes out of the image-owner selector', () => {
    const storeState = state()
    const first = selectNativeChatImageOwnerState(storeState)
    const second = selectNativeChatImageOwnerState({
      ...storeState,
      agentStatusByPaneKey: {} as AppState['agentStatusByPaneKey']
    })

    expect(shallow(second, first)).toBe(true)
  })

  it('reuses derived settings when owner inputs are unchanged', () => {
    const storeState = state()
    const first = resolveNativeChatImageRuntimeContext(storeState, 'tab-1')
    const second = resolveNativeChatImageRuntimeContext(storeState, 'tab-1')

    expect(first).not.toBeNull()
    expect(second?.target).toBe(first?.target)
    expect(shallow(second, first)).toBe(true)
  })

  it('derives a runtime host from an owner-only route during paired hydration', () => {
    const storeState = state()
    const ownerOnlyWorktree = {
      id: 'wt-1',
      repoId: 'repo',
      path: '/repo/worktree',
      runtimeOwnerEnvironmentId: 'owner-a'
    }
    const ownerState = {
      ...storeState,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      getKnownWorktreeById: () => ownerOnlyWorktree,
      worktreesByRepo: { repo: [ownerOnlyWorktree] },
      runtimeEnvironments: [{ id: 'owner-a' }]
    } as unknown as AppState

    const context = resolveNativeChatImageRuntimeContext(ownerState, 'tab-1')

    expect(context).toMatchObject({
      worktreeId: 'wt-1',
      worktreePath: '/repo/worktree',
      expectedExecutionHostId: 'local',
      target: { kind: 'environment' as const, environmentId: 'owner-a' }
    })
  })

  it('reads nothing for an SSH-owned workspace with no paired server to serve it', () => {
    const worktree = worktreeFixture('wt-1', '/remote/worktree', { hostId: 'ssh:ssh-1' })
    const sshState = state({
      activeWorkspaceExecutionHostId: 'ssh:ssh-1',
      getKnownWorktreeById: () => worktree,
      repos: [repoFixture({ connectionId: 'ssh-1' })],
      worktreesByRepo: { repo: [worktree] }
    })

    expect(resolveNativeChatImageRuntimeContext(sshState, 'tab-1')).toBeNull()
  })

  it('resolves a floating chat to its pinned folder on the local host, and nothing before the pin', () => {
    const floatingTab: Tab = {
      id: 'floating-chat-1',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      groupId: 'floating-group',
      contentType: 'agent-session',
      entityId: 'session-1',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0,
      isPinned: false,
      agentSessionAgent: 'codex'
    }
    const floatingState: AppState = {
      ...state(),
      tabsByWorktree: {},
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      getKnownWorktreeById: () => undefined,
      worktreesByRepo: {},
      // Why a focused runtime: floating must stay local even when one is selected.
      settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-1' },
      floatingWorkspacePath: '/home/me/changed-setting'
    }

    expect(resolveNativeChatImageRuntimeContext(floatingState, 'floating-chat-1')).toBeNull()
    expect(
      resolveNativeChatImageRuntimeContext(
        {
          ...floatingState,
          structuredSessionLaunchDirectoryByTabId: {
            'floating-chat-1': { sessionId: 'session-1', launchDirectory: '/home/me/pinned' }
          }
        },
        'floating-chat-1'
      )
    ).toMatchObject({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      worktreePath: '/home/me/pinned',
      expectedExecutionHostId: 'local',
      target: { kind: 'local' as const }
    })
  })
})
