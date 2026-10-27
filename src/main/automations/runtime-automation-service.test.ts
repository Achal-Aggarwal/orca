import { createDesktopRunTerminalLifecycle } from './desktop-run-terminal-lifecycle'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentLauncher from './headless-automation-agent-launch'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTerminalObserver } from './run-completion-watcher'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { automationRunOperationId } from './automation-run-operation'

type Options = {
  headlessDispatcher?: HeadlessAutomationDispatcher
  terminalObserver?: AutomationRunTerminalObserver
}
const captured = vi.hoisted(() => {
  const options: Options = {}
  return {
    options,
    launch: vi.fn(),
    observeChat: vi.fn(),
    markDispatchResult: vi.fn()
  }
})
vi.mock('./service', () => ({
  AutomationService: class {
    start(): void {}
    stop(): void {}
    markDispatchResult = captured.markDispatchResult
    constructor(_store: unknown, opts: Options) {
      captured.options = opts
    }
  }
}))
vi.mock('./headless-automation-agent-launch', async (original) => ({
  ...(await original<typeof AgentLauncher>()),
  launchHeadlessAutomationAgent: captured.launch
}))
vi.mock('./runtime-chat-run-observer', () => ({ observeAutomationChatRun: captured.observeChat }))
import { createRuntimeAutomationService } from './runtime-automation-service'
const state = buildProfileStateCutoverFixture('/fixture')
const run = {
  ...state.automationRuns[0],
  createdAt: 1_700_000_000_000,
  status: 'dispatching' as const,
  chatSessionId: null
}
function fixture(headless: boolean) {
  const rows = new Map<string, unknown>()
  const runtime = {
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    openAgentSessionRecordStore: async () => ({
      getOperationRow: (_caller: string, id: string) => rows.get(id),
      getConversation: () => ({
        sessionId: 'claude_chat',
        provider: 'claude',
        location: { workspaceId: 'wt-1' }
      })
    }),
    getTerminalHandleForPaneKey: vi.fn((_pane: string): string | null => null),
    getTerminalPtyIdForHandle: vi.fn((_handle: string): string | null => 'pty-1'),
    getTerminalPaneKey: vi.fn(
      () => '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    ),
    waitForTerminal: vi.fn(async () => ({ state: 'done' })),
    getAgentStatusRowsForPane: vi.fn(() => [])
  }
  createRuntimeAutomationService({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: construction and recovery use only these store boundaries.
    store: {
      listAutomationRuns: () => [],
      listAutomations: () => [{ id: run.automationId, agentId: 'claude' }]
    } as unknown as Store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launching and chat observation are mocked; the runtime implements the recovery boundaries.
    runtime: runtime as unknown as OrcaRuntimeService,
    ...(headless
      ? { headless: true as const }
      : { headless: false as const, createDesktopLifecycle: createDesktopRunTerminalLifecycle })
  })
  return { runtime, rows }
}
beforeEach(() => {
  vi.clearAllMocks()
  captured.markDispatchResult.mockImplementation(async (result) => ({ ...run, ...result }))
  captured.observeChat.mockResolvedValue({ status: 'completed' })
})
describe('host-owned automation execution', () => {
  it.each([false, true])(
    'uses the same dispatcher on desktop/headless=%s and immediately hands completion to the watcher',
    async (headless) => {
      fixture(headless)
      captured.launch.mockResolvedValue({
        workspaceId: 'wt-1',
        terminalSessionId: 'tab-1',
        terminalPaneKey:
          '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        terminalHandle: 'term-1'
      })
      const dispatcher = captured.options.headlessDispatcher!
      const result = await dispatcher({
        automation: state.automations[0],
        run,
        target: { ok: true, cwd: '/fixture', repo: state.repos[0] }
      })
      expect(result.completion).toBeUndefined()
      expect(captured.launch).toHaveBeenCalledOnce()
      expect(
        captured.options.terminalObserver!.resolveRunTerminal({
          ...run,
          status: 'dispatched',
          terminalPaneKey:
            '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
        })
      ).toBe('term-1')
    }
  )
  it.each(['fresh-launch', 'reuse-send'] as const)(
    'recovers a %s accepted chat before the automation run identity was saved',
    async (purpose) => {
      const { rows } = fixture(false)
      rows.set(automationRunOperationId(run, purpose), {
        outcome: {
          status: 'succeeded',
          sessionId: 'claude_chat',
          ...(purpose === 'fresh-launch'
            ? {
                launch: {
                  worktreeId: 'wt-1',
                  outcome: { kind: 'structured', sessionId: 'claude_chat', handle: 'chat-tab' },
                  receipt: {
                    mode: 'structured',
                    preferred: 'structured',
                    reason: 'requested',
                    detail: 'Chat'
                  },
                  prompt: { delivery: 'submit', outcome: 'journaled', messageId: 'opening' }
                }
              }
            : {})
        }
      })
      const observer = captured.options.terminalObserver!
      const handle = observer.resolveRunTerminal(run)!
      expect(
        await observer.observeCompletion(handle, { run, signal: new AbortController().signal })
      ).toEqual({ status: 'completed' })
      expect(captured.markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKind: 'chat',
          chatSessionId: 'claude_chat',
          terminalPaneKey: null,
          terminalSessionId: null,
          terminalPtyId: null
        })
      )
      expect(captured.observeChat).toHaveBeenCalledOnce()
      expect(captured.launch).not.toHaveBeenCalled()
    }
  )
  it('recovers a terminal reuse receipt without a pane key and never launches again', async () => {
    const { rows, runtime } = fixture(false)
    const originalRun = { ...run, terminalPtyId: 'pty-1' }
    rows.set(automationRunOperationId(run, 'reuse-terminal-launch'), {
      outcome: {
        status: 'succeeded',
        launch: {
          worktreeId: 'wt-1',
          outcome: { kind: 'terminal', handle: 'term-reused' },
          receipt: {
            mode: 'terminal',
            preferred: 'terminal',
            reason: 'requested',
            detail: 'Terminal'
          },
          prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
        }
      }
    })
    runtime.waitForTerminal.mockRejectedValueOnce(new Error('test-stop'))
    const observer = captured.options.terminalObserver!
    await expect(
      observer.observeCompletion(observer.resolveRunTerminal(originalRun)!, {
        run: originalRun,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('test-stop')
    expect(captured.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKind: 'terminal',
        terminalPaneKey:
          '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        terminalSessionId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        terminalPtyId: 'pty-1'
      })
    )
    expect(captured.launch).not.toHaveBeenCalled()
  })
  it.each(['same-process', 'replacement', 'unknown', 'same-id-replacement'] as const)(
    'projects an adopted live handle with independent %s evidence',
    async (proof) => {
      const { rows, runtime } = fixture(false)
      runtime.getTerminalHandleForPaneKey.mockReturnValue('term-adopted')
      runtime.getTerminalPtyIdForHandle.mockImplementation((handle) =>
        handle === 'term-adopted'
          ? proof === 'same-process' || proof === 'same-id-replacement'
            ? 'original-pty'
            : proof === 'replacement'
              ? 'replacement-pty'
              : null
          : proof === 'same-id-replacement'
            ? null
            : 'original-pty'
      )
      const ownRun = {
        ...run,
        status: 'dispatched' as const,
        sessionKind: 'terminal' as const,
        terminalPaneKey: 'tab:leaf',
        terminalPtyId: 'original-pty'
      }
      rows.set(automationRunOperationId(run, 'fresh-launch'), {
        outcome: {
          status: 'succeeded',
          launch: {
            worktreeId: 'wt-1',
            outcome: { kind: 'terminal', handle: 'term-old', paneKey: 'tab:leaf' },
            receipt: {
              mode: 'terminal',
              preferred: 'terminal',
              reason: 'requested',
              detail: 'Terminal'
            },
            prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
          }
        }
      })
      const observer = captured.options.terminalObserver!
      runtime.waitForTerminal.mockRejectedValueOnce(new Error('observed-current-handle'))
      const pending = observer.observeCompletion(observer.resolveRunTerminal(ownRun)!, {
        run: ownRun,
        signal: new AbortController().signal
      })
      if (proof === 'same-process') {
        await expect(pending).rejects.toThrow('observed-current-handle')
      } else {
        expect(await pending).toMatchObject({ status: 'dispatch_failed' })
        expect(runtime.waitForTerminal).not.toHaveBeenCalled()
      }
      expect(captured.launch).not.toHaveBeenCalled()
    }
  )
  it.each(['chat', 'terminal'] as const)(
    'recovers a published failed %s receipt without accepting or sending it',
    async (kind) => {
      const { rows, runtime } = fixture(false)
      rows.set(automationRunOperationId(run, 'fresh-launch'), {
        outcome: {
          status: 'succeeded',
          launch: {
            worktreeId: 'actually-published',
            outcome:
              kind === 'chat'
                ? { kind: 'structured', sessionId: 'claude_published', handle: 'chat-tab' }
                : {
                    kind: 'terminal',
                    handle: 'term-published',
                    paneKey: 'tab:11111111-1111-4111-8111-111111111111'
                  },
            receipt: {
              mode: kind === 'chat' ? 'structured' : 'terminal',
              preferred: kind === 'chat' ? 'structured' : 'terminal',
              reason: 'requested',
              detail: 'Published'
            },
            prompt: { delivery: 'submit', outcome: 'unconfirmed' }
          }
        }
      })
      const observer = captured.options.terminalObserver!
      expect(
        await observer.observeCompletion(observer.resolveRunTerminal(run)!, {
          run,
          signal: new AbortController().signal
        })
      ).toMatchObject({ status: 'dispatch_failed' })
      expect(captured.markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'actually-published',
          status: 'dispatch_failed',
          sessionKind: kind,
          ...(kind === 'chat'
            ? { chatSessionId: 'claude_published', terminalPaneKey: null }
            : {
                terminalSessionId: 'tab',
                terminalPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
              })
        })
      )
      expect(runtime.waitForTerminal).not.toHaveBeenCalled()
      expect(captured.observeChat).not.toHaveBeenCalled()
      expect(captured.launch).not.toHaveBeenCalled()
    }
  )
  it('refuses an ambiguous crash without resending or marking success', async () => {
    const { rows } = fixture(false)
    rows.set(automationRunOperationId(run, 'fresh-launch'), { outcome: { status: 'unknown' } })
    const observer = captured.options.terminalObserver!
    expect(
      await observer.observeCompletion(observer.resolveRunTerminal(run)!, {
        run,
        signal: new AbortController().signal
      })
    ).toMatchObject({ status: 'dispatch_failed', error: expect.stringContaining('Claude') })
    expect(captured.launch).not.toHaveBeenCalled()
  })
})
