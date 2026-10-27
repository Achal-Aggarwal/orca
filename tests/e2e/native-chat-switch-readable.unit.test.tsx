import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cliTranscript from '../../src/main/ai-vault/structured-chat-cli-fork'
import { createRestTestRig } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID
} from '../../src/main/runtime/main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from '../../src/main/runtime/rpc/methods/structured-agent-session-switch-execution'
import { structuredAgentRuntimeRegistration } from '../../src/main/runtime/structured-agent-runtime-registrations'
import { agentSessionProviderHandleChainHead } from '../../src/shared/agent-session-provider-handle'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRefusalError } from '../../src/shared/agent-session-wire-refusals'
import { beginSwitchPresentation } from '@/lib/conversation-switch-presentation'
import { NativeChatStructuredSession } from '../../src/renderer/src/components/native-chat/NativeChatStructuredSession'
import {
  stubLayout,
  stubResizeObserver,
  deliverResizes
} from '../../src/renderer/src/components/native-chat/native-chat-windowing-test-harness'
import { resetStructuredAgentSessionReadOwnersForTests } from '../../src/renderer/src/components/native-chat/structured-agent-session-read-owner'
import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../src/shared/agent-session-wire'
import type * as StructuredAgentSessionClientModule from '@/runtime/structured-agent-session-client'

// @vitest-environment happy-dom

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (
    await import('../../src/renderer/src/components/native-chat/NativeChatStructuredSession.test-harness')
  ).createStructuredSessionMocks()
)
const feed = vi.hoisted(() => ({ cursor: { epoch: 'epoch', sequence: 1 } }))
vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/runtime/structured-agent-session-client', async (actual) => ({
  ...(await actual<typeof StructuredAgentSessionClientModule>()),
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: async (
    _target: unknown,
    params: { sessionId: string },
    onEvent: (event: AgentSessionSubscribeEvent) => void
  ) => {
    onEvent({
      type: 'batch',
      sessionId: params.sessionId,
      batch: {
        cursor: feed.cursor,
        items: [],
        removedItemIds: [],
        submissions: []
      }
    })
    return { unsubscribe: () => {} }
  },
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} }),
  supportsStructuredAgentSessionQuietRepeatedStop: async () => false
}))
vi.mock('../../src/renderer/src/components/native-chat/use-native-chat-font-size', () =>
  moduleFactories.useNativeChatFontSize()
)
vi.mock('../../src/renderer/src/components/native-chat/use-native-chat-file-link-context', () =>
  moduleFactories.useNativeChatFileLinkContext()
)
vi.mock('../../src/renderer/src/components/native-chat/use-native-chat-file-link-click', () =>
  moduleFactories.useNativeChatFileLinkClick()
)
vi.mock('../../src/renderer/src/components/native-chat/NativeChatComposer', () =>
  moduleFactories.nativeChatComposer()
)
vi.mock('../../src/renderer/src/components/native-chat/NativeChatApprovalCard', () =>
  moduleFactories.nativeChatApprovalCard()
)
vi.mock('../../src/renderer/src/components/native-chat/NativeChatQuestionCard', () =>
  moduleFactories.nativeChatQuestionCard()
)
const restores: (() => void)[] = []
const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposals.splice(0)) {
    await dispose()
  }
  setStructuredAgentSessionHost(null)
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredSessionMocks()
  for (const restore of restores.splice(0).toReversed()) {
    restore()
  }
  vi.restoreAllMocks()
})
it.each(['readable', 'refused', 'unmounted'] as const)(
  'acknowledges the real cold root only after its first history is %s',
  async (outcome) => {
    const restoreLayout = stubLayout()
    const restoreResize = stubResizeObserver()
    restores.push(restoreLayout, restoreResize)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({})
    }))
    const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
    disposals.push(rig.dispose)
    const params = createTestParams()
    await rig.host.create(
      CREATE_TEST_CALLER,
      createTestParams(undefined, {
        location: { ...params.location, workspaceId: WORKTREE_ID }
      })
    )
    setStructuredAgentSessionHost(rig.host)
    await rig.host.switchToChat(HOST_TEST_SESSION)
    await rig.host.switchToTerminal(HOST_TEST_SESSION)
    rig.adapter.acquire.mockClear()
    const record = rig.store.getRecord(HOST_TEST_SESSION)!
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)!
    const nativeId = head.handle.nativeId
    const filePath = join(rig.root, 'readable.jsonl')
    await writeFile(
      filePath,
      `${[
        { type: 'session_meta', payload: { id: nativeId } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'terminal-turn' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Readable before Codex is ready' }]
          }
        },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'terminal-turn' } }
      ]
        .map((row) => JSON.stringify({ timestamp: '2026-10-26T12:00:00Z', ...row }))
        .join('\n')}\n`
    )
    // External lookup is the I/O boundary; import, journal, command, receipt and root stay real.
    vi.spyOn(cliTranscript, 'resolveStructuredChatCliSource').mockResolvedValue({
      host: rig.host,
      record,
      head,
      agent: 'codex',
      cwd: rig.root,
      providerSessionId: nativeId,
      registration: structuredAgentRuntimeRegistration('codex')!,
      requireCurrent: () => {
        const current = rig.store.requireWritableRecord(record.sessionId)
        expect(current.location).toEqual(record.location)
        expect(agentSessionProviderHandleChainHead(current.providerHandleChain)?.linkId).toBe(
          head.linkId
        )
      }
    })
    vi.spyOn(cliTranscript, 'prepareStructuredChatCliTranscript').mockResolvedValue({
      useRealCodexHome: false,
      cliForkSource: {
        agent: 'codex',
        sourceAgent: 'codex',
        sessionId: nativeId,
        filePath,
        cwd: rig.root,
        codexHome: null,
        executionHostPlatform: process.platform
      }
    })
    const { runtime } = setupMainOwnedWorkspace()
    vi.spyOn(runtime, 'inspectTerminalProcess').mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children',
      switchWitness: 'before-probe'
    })
    vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockImplementation(async (input) => {
      input.check?.()
      await rig.store.setSessionTabVisibility(HOST_TEST_SESSION, true)
    })
    const close = vi.spyOn(runtime, 'closeSwitchedSourceTerminal').mockResolvedValue(true)
    const invocation = {
      sessionId: HOST_TEST_SESSION,
      execution: {
        invocationId: 'root-readable',
        source: { terminal: 'source', expectedIncarnationId: 'source-incarnation' }
      }
    }
    const viewResult = await executeStructuredSessionSwitch(invocation, { runtime }, 'chat')
    if (viewResult.status !== 'present') {
      throw new Error('missing presentation')
    }
    const page = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    if (!page.ok || !page.page.liveCursor) {
      throw new Error('missing imported history')
    }
    feed.cursor = page.page.liveCursor
    const read = Promise.withResolvers<AgentSessionHistoryResult>()
    mocks.call.mockImplementation(async (_target, method) => {
      if (method === 'agentSession.history') {
        return read.promise
      }
      return { ok: true, models: [], current: { model: '' } }
    })
    const visit = beginSwitchPresentation({ kind: 'local' }, HOST_TEST_SESSION)
    const shown = vi.fn()
    const completion = visit.shown.then(async (readable) => {
      shown(readable)
      return executeStructuredSessionSwitch(
        {
          ...invocation,
          execution: {
            ...invocation.execution,
            receipt: { generation: viewResult.generation, shown: readable }
          }
        },
        { runtime },
        'chat'
      )
    })
    const view = render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="cold-tab"
        sessionId={HOST_TEST_SESSION}
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(
        expect.anything(),
        'agentSession.history',
        expect.anything()
      )
    )
    expect(shown).not.toHaveBeenCalled()
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('status', { name: 'Loading chat' })).toBeTruthy()
    if (outcome === 'unmounted') {
      view.unmount()
    }
    await act(async () =>
      outcome === 'refused'
        ? read.reject(
            agentSessionRefusalError('agent_session_journal_unreadable', {
              reason: 'journalCorrupt'
            })
          )
        : read.resolve(page)
    )
    await waitFor(() => {
      act(() => {
        deliverResizes()
      })
      expect(shown).toHaveBeenCalledExactlyOnceWith(outcome === 'readable')
    })
    const opened = await completion
    if (outcome === 'readable') {
      expect(screen.getByText('Readable before Codex is ready')).toBeTruthy()
      expect(opened).toMatchObject({ status: 'completed', startupPending: true })
      await executeStructuredSessionSwitch(
        {
          ...invocation,
          execution: {
            ...invocation.execution,
            observe: true
          }
        },
        { runtime },
        'chat'
      )
      expect(rig.adapter.acquire).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
    } else {
      expect(opened).toMatchObject({
        status: 'uncertain',
        refusal: { details: { reason: 'tabUnconfirmed' } }
      })
      expect(rig.adapter.acquire).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
    }
    visit.release()
  }
)
