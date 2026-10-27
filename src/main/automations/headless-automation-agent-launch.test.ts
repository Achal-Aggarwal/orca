import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  createQueuedMessageTestRig,
  eventually
} from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { hostTestAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { runHeadlessAutomationDispatch } from './headless-dispatch-runner'
import { observeAutomationChatRun } from './runtime-chat-run-observer'
import { createAutomationRunWriter } from './automation-run-writer'
import {
  createStore,
  closeTestStores,
  testState,
  readPersistedStateJson
} from '../persistence/persistence-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAutomationRunWorkspaceAction } from '../../renderer/src/components/automations/automation-run-workspace-action'
import type { AutomationsPageActionContext } from '../../renderer/src/components/automations/automations-page-action-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { automationRunOperationId } from './automation-run-operation'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'

const mocks = vi.hoisted(() => ({
  actualHost: null as StructuredAgentSessionHost | null,
  openChat: vi.fn(),
  readChat: vi.fn(async () => ({})),
  launch: vi.fn(),
  host: { journalSnapshot: vi.fn(), currentWork: vi.fn(), send: vi.fn() }
}))
vi.mock('../runtime/rpc/methods/agent-launch', () => ({ launchAgentOnHost: mocks.launch }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => mocks.actualHost ?? mocks.host
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (...args: unknown[]) => mocks.readChat(...args)
}))
vi.mock('@/lib/structured-agent-session-launch-surface', () => ({
  openStructuredAgentSessionProvisionalTab: (...args: unknown[]) => mocks.openChat(...args)
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: () => true }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {},
      repos: [],
      worktreesByRepo: {},
      getTab: () => undefined,
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {}
    })
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
const state = buildProfileStateCutoverFixture('/fixture')
const run = { ...state.automationRuns[0], id: 'run-1', createdAt: Date.now() }
const automation = {
  ...state.automations[0],
  id: run.automationId,
  agentId: 'claude' as const,
  workspaceMode: 'existing' as const,
  workspaceId: 'wt-1',
  prompt: 'Audit',
  extraAgentArgs: undefined
}
const target = { ok: true as const, repo: state.repos[0], cwd: '/fixture' }
const terminal: AgentLaunchResult = {
  worktreeId: 'wt-1',
  outcome: { kind: 'terminal', handle: 'term-1', paneKey: 'tab-1:leaf-1' },
  receipt: { mode: 'terminal', preferred: 'terminal', reason: 'requested', detail: 'Terminal' },
  prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
}
const chat: AgentLaunchResult = {
  ...terminal,
  outcome: { kind: 'structured', sessionId: 'claude_chat', handle: 'chat-tab' },
  prompt: { delivery: 'submit', outcome: 'journaled', messageId: 'first-message' }
}
function fixture() {
  const records = {
    getOperationRow: vi.fn(),
    getConversation: vi.fn(() => ({
      sessionId: 'claude_prev',
      provider: 'claude',
      location: { workspaceId: 'wt-1' },
      currentFence: 2
    }))
  }
  const runtime = {
    requireStore: () => ({
      getSettings: () => ({
        experimentalNativeChat: true,
        workspaceDir: '/fixture',
        nestWorkspaces: false,
        agentDefaultArgs: { claude: '--model sonnet --add-dir docs' }
      })
    }),
    showTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'wt-1',
      path: '/fixture',
      connectionId: 'ssh-test'
    })),
    showManagedWorktree: vi.fn(async () => ({ displayName: 'Audit' })),
    showTerminal: vi.fn(async () => ({ tabId: 'tab-1' })),
    getTerminalPtyIdForHandle: vi.fn(() => 'pty-1'),
    getTerminalPaneKey: vi.fn(() => 'tab-1:leaf-1'),
    getTerminalHandleForPaneKey: vi.fn(() => 'term-prev'),
    getAgentStatusRowsForPane: vi.fn(() => [{ state: 'done', agentType: 'claude', receivedAt: 1 }]),
    ensureStructuredAgentSessionHost: vi.fn(),
    openAgentSessionRecordStore: vi.fn(async () => records)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the runtime boundaries above are reached; the ordinary launch is mocked separately.
  return { runtime: runtime as unknown as OrcaRuntimeService, records }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actualHost = null
  mocks.launch.mockResolvedValue(terminal)
  mocks.host.currentWork.mockReturnValue({ working: () => false })
  mocks.host.send.mockResolvedValue({ ok: true })
})
describe('automations through agent.launch', () => {
  it.each(['claude', 'codex'] as const)(
    'pins legacy %s runs to Terminal and preserves unattended/background policy',
    async (agentId) => {
      const { runtime } = fixture()
      const result = await launchHeadlessAutomationAgent(runtime, {
        automation: { ...automation, surface: undefined, agentId },
        run,
        target,
        runs: []
      })
      expect(mocks.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: agentId,
          surface: 'terminal',
          operationId: automationRunOperationId(run, 'fresh-launch'),
          prompt: { text: 'Audit', delivery: 'submit' },
          presentation: 'background',
          target: { kind: 'existing', worktree: 'id:wt-1' }
        }),
        expect.objectContaining({ runtime }),
        expect.objectContaining({
          terminalTitle: run.title,
          suppressStartupUpdatePrompt: true,
          unprovableHost: 'write-unless-shell',
          onSurfacePublished: expect.any(Function)
        })
      )
      expect(result).toMatchObject({
        workspaceDisplayName: 'Audit',
        sessionKind: 'terminal',
        chatSessionId: null,
        terminalPtyId: 'pty-1'
      })
    }
  )
  it('merges Terminal extras over the live host defaults, and never applies them to Chat', async () => {
    const { runtime } = fixture()
    await launchHeadlessAutomationAgent(runtime, {
      automation: { ...automation, extraAgentArgs: '--model opus' },
      run,
      target,
      runs: []
    })
    expect(tokenizeStartupCommand(mocks.launch.mock.calls[0][0].agentArgs, 'posix')).toMatchObject({
      ok: true,
      tokens: ['--add-dir', 'docs', '--model', 'opus']
    })
    mocks.launch.mockResolvedValue(chat)
    await launchHeadlessAutomationAgent(runtime, {
      automation: { ...automation, surface: 'chat', extraAgentArgs: '--model opus' },
      run: { ...run, id: 'chat-run' },
      target,
      runs: []
    })
    expect(mocks.launch.mock.calls[1][0].agentArgs).toBeUndefined()
  })
  it('retains the actual pane for a reused terminal whose launch result has only a handle', async () => {
    const { runtime } = fixture()
    mocks.launch.mockResolvedValue({
      ...terminal,
      outcome: { kind: 'terminal', handle: 'term-prev' }
    })
    const result = await launchHeadlessAutomationAgent(runtime, {
      automation: { ...automation, reuseSession: true },
      run,
      target,
      runs: [
        {
          ...run,
          id: 'old',
          status: 'completed',
          workspaceId: 'wt-1',
          sessionKind: 'terminal',
          terminalPaneKey: 'old:leaf',
          terminalPtyId: 'pty-1'
        }
      ]
    })
    expect(result).toMatchObject({ terminalPaneKey: 'tab-1:leaf-1', terminalPtyId: 'pty-1' })
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })
  it('refuses an expired admission without minting another launch identity', async () => {
    const { runtime } = fixture()
    mocks.launch.mockRejectedValue(new Error('agent_session_operation_expired'))
    await expect(
      launchHeadlessAutomationAgent(runtime, { automation, run, target, runs: [] })
    ).rejects.toThrow(
      'Claude could not start because this run waited too long. Run the automation again.'
    )
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })
  it('records the actual chat identity and delegates new workspace setup and provenance', async () => {
    const { runtime } = fixture()
    mocks.launch.mockResolvedValue(chat)
    const result = await launchHeadlessAutomationAgent(runtime, {
      automation: {
        ...automation,
        surface: 'chat',
        workspaceMode: 'new_per_run',
        workspaceId: null,
        setupDecision: 'run'
      },
      run,
      target,
      runs: []
    })
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'chat',
        target: {
          kind: 'create-worktree',
          create: expect.objectContaining({
            setupDecision: 'run',
            activate: false,
            automationProvenanceRequest: expect.objectContaining({
              automationId: automation.id,
              automationRunId: run.id
            })
          })
        }
      }),
      expect.anything(),
      expect.anything()
    )
    expect(result).toMatchObject({
      sessionKind: 'chat',
      chatSessionId: 'claude_chat',
      terminalHandle: null,
      terminalPaneKey: null,
      terminalSessionId: null,
      terminalPtyId: null
    })
  })
  it('separates a proven no-effect terminal reuse refusal from the fresh launch identity', async () => {
    const { runtime, records } = fixture()
    records.getOperationRow.mockReturnValue({ outcome: { status: 'failed' } })
    mocks.launch
      .mockRejectedValueOnce(new Error('no longer an agent'))
      .mockResolvedValueOnce(terminal)
    const previous = {
      ...run,
      id: 'old',
      workspaceId: 'wt-1',
      status: 'completed' as const,
      sessionKind: 'terminal' as const,
      terminalPaneKey: 'old:leaf',
      terminalPtyId: 'pty-1'
    }
    await launchHeadlessAutomationAgent(runtime, {
      automation: { ...automation, reuseSession: true },
      run,
      target,
      runs: [previous]
    })
    expect(mocks.launch.mock.calls.map(([input]) => input.operationId)).toEqual([
      automationRunOperationId(run, 'reuse-terminal-launch'),
      automationRunOperationId(run, 'fresh-launch')
    ])
  })
  it('never falls back after an ambiguous reuse launch', async () => {
    const { runtime, records } = fixture()
    records.getOperationRow.mockReturnValue({ outcome: { status: 'unknown' } })
    mocks.launch.mockRejectedValue(new Error('lost reply'))
    await expect(
      launchHeadlessAutomationAgent(runtime, {
        automation: { ...automation, reuseSession: true },
        run,
        target,
        runs: [
          {
            ...run,
            id: 'old',
            workspaceId: 'wt-1',
            status: 'completed',
            terminalPaneKey: 'old:leaf',
            terminalPtyId: 'pty-1'
          }
        ]
      })
    ).rejects.toMatchObject({ target: { workspaceId: 'wt-1', sessionKind: 'terminal' } })
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })
  it('reuses only a completed compatible idle chat and derives a separate send identity', async () => {
    const { runtime } = fixture()
    const previous = {
      ...run,
      id: 'old',
      status: 'completed' as const,
      workspaceId: 'wt-1',
      sessionKind: 'chat' as const,
      chatSessionId: 'claude_prev'
    }
    const result = await launchHeadlessAutomationAgent(runtime, {
      automation: { ...automation, surface: 'chat', reuseSession: true },
      run,
      target,
      runs: [previous]
    })
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.host.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'claude_prev',
          clientOperationId: automationRunOperationId(run, 'reuse-send'),
          expectedRuntimeFence: 2
        })
      })
    )
    expect(result.chatSessionId).toBe('claude_prev')
  })
  it('does not reuse a chat whose newest run or current human turn is unfinished', async () => {
    const { runtime } = fixture()
    mocks.launch.mockResolvedValue(chat)
    mocks.host.currentWork.mockReturnValue({ working: () => true })
    await launchHeadlessAutomationAgent(runtime, {
      automation: { ...automation, surface: 'chat', reuseSession: true },
      run,
      target,
      runs: [
        {
          ...run,
          id: 'old',
          status: 'completed',
          workspaceId: 'wt-1',
          sessionKind: 'chat',
          chatSessionId: 'claude_prev'
        }
      ]
    })
    expect(mocks.host.send).not.toHaveBeenCalled()
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })
})

it.each(['terminal', 'chat', 'reuse-terminal'] as const)(
  'preserves published %s identity for refused, uncertain and throwing settlement',
  async (kind) => {
    const { runtime, records } = fixture()
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const published =
      kind === 'chat'
        ? chat
        : { ...terminal, outcome: { kind: 'terminal' as const, handle: 'term-1', paneKey } }
    for (const outcome of ['not-delivered', 'unconfirmed', 'throw', 'accepted-throw'] as const) {
      mocks.launch.mockImplementationOnce(async (_params, _context, policy) => {
        policy.onSurfacePublished(published)
        if (outcome === 'accepted-throw') {
          records.getOperationRow.mockImplementation((_caller, id) =>
            id ===
            automationRunOperationId(
              run,
              kind === 'reuse-terminal' ? 'reuse-terminal-launch' : 'fresh-launch'
            )
              ? { outcome: { status: 'succeeded', launch: published } }
              : undefined
          )
          throw new Error('accepted reply lost')
        }
        if (outcome === 'throw') {
          throw new Error('settlement transport lost')
        }
        return { ...published, prompt: { delivery: 'submit', outcome } }
      })
      const result = await launchHeadlessAutomationAgent(runtime, {
        automation: {
          ...automation,
          surface: kind === 'chat' ? 'chat' : 'terminal',
          reuseSession: kind === 'reuse-terminal'
        },
        run,
        target,
        runs:
          kind === 'reuse-terminal'
            ? [
                {
                  ...run,
                  id: 'old',
                  status: 'completed',
                  workspaceId: 'wt-1',
                  sessionKind: 'terminal',
                  terminalPaneKey: 'old:leaf',
                  terminalPtyId: 'pty-1'
                }
              ]
            : []
      }).catch((error) => error)
      expect(outcome === 'accepted-throw' ? { target: result } : result).toMatchObject({
        target: {
          workspaceId: 'wt-1',
          sessionKind: kind === 'chat' ? 'chat' : 'terminal',
          ...(kind === 'chat'
            ? { chatSessionId: 'claude_chat', terminalPaneKey: null, terminalSessionId: null }
            : {
                terminalPaneKey: paneKey,
                terminalSessionId: 'tab-1',
                terminalPtyId: 'pty-1'
              })
        }
      })
    }
    expect(mocks.launch).toHaveBeenCalledTimes(4)
    expect(mocks.host.send).not.toHaveBeenCalled()
  }
)

it('keeps accepted reused Chat through throwing metadata/reply, real runner persistence, observation and normal Details', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  const rig = await createQueuedMessageTestRig({ restartable: true })
  mocks.actualHost = rig.host
  const root = mkdtempSync(join(tmpdir(), 'orca-34332-accepted-'))
  testState.dir = root
  const disk = createStore()
  const id = 'codex_reused'
  const initial = hostTestAttachParams(null)
  const controller = new AbortController()
  try {
    expect(
      await rig.host.create(
        { callerKey: 'initial' },
        hostTestAttachParams(null, {
          envelope: { ...initial.envelope, sessionId: id },
          location: { ...initial.location, workspaceId: 'wt-1' }
        })
      )
    ).toMatchObject({ ok: true })
    disk.addRepo(state.repos[0])
    const saved = disk.createAutomation({
      ...automation,
      agentId: 'codex',
      surface: 'chat',
      reuseSession: true,
      projectId: state.repos[0].id
    })
    const writer = createAutomationRunWriter(disk, null)
    const sent = rig.host.send.bind(rig.host)
    for (const lostReply of [false, true]) {
      const current = await writer.createRun(saved, Date.now(), 'manual')
      const previous = {
        ...current,
        id: 'previous',
        status: 'completed' as const,
        workspaceId: 'wt-1',
        sessionKind: 'chat' as const,
        chatSessionId: id
      }
      const send = vi.spyOn(rig.host, 'send').mockImplementationOnce(async (...args) => {
        const answer = await sent(...args)
        expect(answer.ok).toBe(true)
        if (lostReply) {
          throw new Error('accepted reply lost')
        }
        return answer
      })
      // SAFETY: runtime transport/metadata only; send, receipt, result, runner, writer and observer use their actual owners.
      const runtime = {
        ensureStructuredAgentSessionHost: async () => {},
        openAgentSessionRecordStore: async () => rig.store,
        showManagedWorktree: async () => {
          throw new Error('optional display unavailable')
        }
      } as unknown as OrcaRuntimeService
      const dispatched = await runHeadlessAutomationDispatch({
        automation: saved,
        run: current,
        target,
        runs: writer,
        dispatcher: () =>
          launchHeadlessAutomationAgent(runtime, {
            automation: saved,
            run: current,
            target,
            runs: [previous]
          }),
        runPrecheck: async () => null,
        markDispatchResult: writer.updateRun,
        watchRun: () => {}
      })
      expect(send).toHaveBeenCalledOnce()
      expect(dispatched).toMatchObject({
        status: 'dispatched',
        sessionKind: 'chat',
        chatSessionId: id
      })
      const pending = observeAutomationChatRun(runtime, dispatched, controller.signal)
      const journal = rig.host.collaboratorsForTests().sessions.get(id)!.journal
      const message = automationRunOperationId(current, 'reuse-send')
      await eventually(() => expect(journal.submission(message)).toBeDefined())
      const item = await journal.appendItem(
        { provider: 'orca', clientMessageId: `turn-${current.id}` },
        {
          kind: 'turn',
          turnId: current.id,
          userItemId: agentJournalSubmissionKey(message),
          state: 'running'
        },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
      await journal.resolveDispatch({
        clientMessageId: message,
        state: 'accepted',
        providerIdentity: { provider: 'orca', clientMessageId: message },
        fence: 1
      })
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `answer-${current.id}` },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Exact automation output' }]
        },
        { fence: 1, turnScope: { kind: 'turn', turnItemId: item.itemId } }
      )
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `turn-${current.id}` },
        {
          kind: 'turn',
          turnId: current.id,
          userItemId: agentJournalSubmissionKey(message),
          state: 'completed',
          outcome: 'success'
        },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
      const observation = await pending
      const completed = await writer.updateRun({ runId: current.id, ...observation })
      expect(completed).toMatchObject({
        status: 'completed',
        chatSessionId: id,
        outputSnapshot: { content: 'Exact automation output' }
      })
      const persisted = JSON.parse(readPersistedStateJson(join(root, 'orca-data.json')))
      expect(
        persisted.automationRuns.find((row: { id: string }) => row.id === current.id)
      ).toMatchObject({ chatSessionId: id, status: 'completed' })
      // SAFETY: normal action's surrounding page context is scripted; actual Details action executes.
      const context = {
        store: {
          repoForRow: () => undefined,
          worktreeForRow: () => ({ id: 'wt-1', hostId: 'local' })
        },
        list: { selectedRow: { key: 'row' } }
      } as unknown as AutomationsPageActionContext
      createAutomationRunWorkspaceAction(context)(completed)
      await eventually(() =>
        expect(mocks.openChat).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: id, agent: 'codex' })
        )
      )
      send.mockRestore()
      mocks.openChat.mockClear()
    }
  } finally {
    controller.abort()
    mocks.actualHost = null
    await rig.dispose()
    await closeTestStores()
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['unknown', 'refused'] as const)(
  'retains known reused Chat on %s acceptance without resending',
  async (acceptance) => {
    const { runtime, records } = fixture()
    mocks.host.send.mockImplementationOnce(async () => {
      if (acceptance === 'unknown') {
        throw new Error('transport lost')
      }
      return { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
    })
    records.getOperationRow.mockReturnValue(undefined)
    await expect(
      launchHeadlessAutomationAgent(runtime, {
        automation: { ...automation, surface: 'chat', reuseSession: true },
        run,
        target,
        runs: [
          {
            ...run,
            id: 'old',
            status: 'completed',
            workspaceId: 'wt-1',
            sessionKind: 'chat',
            chatSessionId: 'claude_prev'
          }
        ]
      })
    ).rejects.toMatchObject({ target: { sessionKind: 'chat', chatSessionId: 'claude_prev' } })
    expect(mocks.host.send).toHaveBeenCalledOnce()
    expect(mocks.launch).not.toHaveBeenCalled()
  }
)

afterEach(() => vi.restoreAllMocks())
