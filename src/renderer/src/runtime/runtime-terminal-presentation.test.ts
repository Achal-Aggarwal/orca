// @vitest-environment happy-dom
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { setLocalRuntimeCapabilitiesForTests } from './local-runtime-capabilities'
import { createRuntimeTerminalInspectionFixtures } from './runtime-terminal-inspection-test-fixtures'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { sendRuntimePtyInputVerified } from './runtime-terminal-verified-input'
import { afterEach } from 'vitest'
import { useTerminalPaneChatState } from '../components/terminal-pane/use-terminal-pane-chat-state'
import { createPtyInputWriteQueue } from '../components/terminal-pane/pty-input-write-queue'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import {
  acceptDesktopPresentationFrame,
  retractDesktopPresentations,
  subscribeDesktopPresentation,
  desktopPresentationSnapshot,
  desktopPresentationForExit
} from './terminal-foreground-presentation'
import { makeUnifiedTab, makeTab } from '../store/slices/store-session-test-harness'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { TerminalPresentationObservation } from '../../../shared/terminal-foreground-presentation'
import { makeHostSnapshot } from './host-session-mirror-frame-fixtures'
import { describe, expect, it, vi } from 'vitest'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInput
} from './runtime-terminal-inspection'
import type { RuntimeEnvironmentCallRequest } from './runtime-compatibility-test-fixture'
import { useAppStore } from '../store'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const shellPresentation = {
  support: 'supported' as const,
  incarnationId: 'inc',
  version: 1,
  state: 'not-in-front' as const
}

function presentationFrame(
  worktree: string,
  id: string,
  incarnationId: string,
  presentation?: TerminalPresentationObservation
): RuntimeMobileSessionTabsResult {
  const frame = makeHostSnapshot(worktree, id, id)
  for (const tab of frame.tabs) {
    if (tab.type === 'terminal') {
      Object.assign(tab, { ptyId: id, incarnationId, presentation })
    }
  }
  return frame
}

describe('runtime terminal presentation routing', () => {
  const {
    runtimeCall,
    localWrite,
    localWriteAccepted,
    localForeground,
    localHasChildren,
    localInspect
  } = createRuntimeTerminalInspectionFixtures()
  afterEach(cleanup)
  it.each([10, 100])(
    'sends %s separated 16KiB physical queue chunks with no presentation work',
    async (n) => {
      const id = `queue-${n}`
      const listener = vi.fn()
      const stop = subscribeDesktopPresentation(id, listener)
      const writes = vi.fn(async (pty: string, data: string, inputKind: TerminalInputKind) => {
        await sendRuntimePtyInput(pty, data, inputKind)
      })
      const queue = createPtyInputWriteQueue({ isWritable: () => true, write: writes })
      const chunk = `${'x'.repeat(16 * 1024 - 1)}\n`
      for (let i = 0; i < n; i++) {
        expect(queue.enqueue(id, chunk, 'driving')).toBe(true)
        await queue.waitForDrain()
      }
      expect(writes).toHaveBeenCalledTimes(n)
      expect(localWrite).toHaveBeenCalledTimes(n)
      expect(localWrite.mock.calls.map(([, data]) => data).join('')).toBe(chunk.repeat(n))
      expect(localInspect).not.toHaveBeenCalled()
      expect(localForeground).not.toHaveBeenCalled()
      expect(localHasChildren).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
      stop()
    }
  )
  it.each(['mounted', 'unmounted', 'refused', 'title-sibling', 'legacy'])(
    'uses actual route/store owner for %s',
    async (flow) => {
      const refused = flow === 'refused'
      const id = `actual-owner-${flow}`
      const leaf = LEAF_ID
      const sibling = '22222222-2222-4222-8222-222222222222'
      const active = flow === 'title-sibling' ? sibling : leaf
      const tab = makeUnifiedTab({
        id: 'actual-tab',
        worktreeId: 'wt',
        groupId: 'g',
        viewMode: 'chat'
      })
      const layout = {
        root: { type: 'leaf' as const, leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        chatLeafId: leaf,
        ptyIdsByLeafId: { [leaf]: id }
      }
      useAppStore.setState({
        unifiedTabsByWorktree: { wt: [tab] },
        tabsByWorktree: { wt: [makeTab({ id: 'actual-tab', worktreeId: 'wt', viewMode: 'chat' })] },
        terminalLayoutsByTabId: { 'actual-tab': layout },
        agentStatusByPaneKey: {},
        paneForegroundAgentByPaneKey: {},
        runtimePaneTitlesByTabId: { 'actual-tab': { 2: 'codex' } },
        settings: createGlobalSettingsFixture({
          ...useAppStore.getState().settings,
          experimentalNativeChat: true
        })
      })
      const writes: string[] = []
      const unsubscribe = useAppStore.subscribe((state, previous) => {
        if (state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree) {
          writes.push('mode')
        }
        if (state.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId) {
          writes.push('layout')
        }
      })
      const answers: ((value: unknown) => void)[] = []
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this hook calls only runtime.call; the installed test window has no other runtime ports.
      window.api.runtime = { call: runtimeCall } as never
      runtimeCall.mockImplementation((request: RuntimeEnvironmentCallRequest) =>
        request.method === 'layout.apply'
          ? new Promise((done) => {
              answers.push(done)
            })
          : Promise.resolve({ ok: true, result: {} })
      )
      const controller = {
        tabId: 'actual-tab',
        worktreeId: 'wt',
        paneCount: 1,
        tabWideAgentHintLeafId: null,
        setTabWideAgentHintLeafId: vi.fn(),
        nativeChatTranscriptIsLocalReadable: true,
        onAgentExitedRef: { current: vi.fn() },
        managerRef: {
          current: {
            getPanes: () => [
              { id: 1, leafId: leaf },
              { id: 2, leafId: sibling }
            ],
            getActivePane: () => ({ id: active === leaf ? 1 : 2, leafId: active })
          }
        }
      }
      function useActualOwner() {
        const [chatLeafId, setChatLeafId] = useState<string | null>(leaf)
        const props = { ...controller, chatLeafId, setChatLeafId }
        return useTerminalPaneChatState(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: props supplies every controller port read by this hook; unrelated terminal managers are intentionally absent.
          props as unknown as Parameters<typeof useTerminalPaneChatState>[0]
        )
      }
      localWriteAccepted.mockResolvedValue(true)
      const rows = useAppStore.getState().agentStatusByPaneKey
      let hook = flow === 'unmounted' ? null : renderHook(useActualOwner)
      localInspect.mockResolvedValue({
        foregroundProcess: 'zsh',
        hasChildProcesses: true,
        presentation: shellPresentation
      })
      await act(async () => {
        if (flow === 'legacy') {
          setLocalRuntimeCapabilitiesForTests([])
          controller.onAgentExitedRef.current(leaf)
        } else {
          await inspectRuntimeTerminalProcess(id)
        }
      })
      if (!hook) {
        hook = renderHook(useActualOwner)
      }
      expect(hook.result.current.effectiveChatViewMode).toBe(
        flow === 'title-sibling' || (ORCA_LAYOUT_OWNER_IS_MAIN && flow === 'legacy')
      )
      expect(hook.result.current.chatLeafId).toBe(flow === 'title-sibling' ? sibling : null)
      if (ORCA_LAYOUT_OWNER_IS_MAIN && flow !== 'title-sibling') {
        expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
        for (const version of flow === 'legacy' ? [] : [2, 3]) {
          localInspect.mockResolvedValue({
            foregroundProcess: 'zsh',
            hasChildProcesses: true,
            presentation: {
              ...shellPresentation,
              version,
              state: version === 2 ? undefined : 'not-in-front'
            }
          })
          await act(async () => {
            await inspectRuntimeTerminalProcess(id)
          })
        }
        expect(
          runtimeCall.mock.calls.filter(
            ([request]) =>
              request.method === 'layout.apply' && request.params.command.type === 'setTabProps'
          )
        ).toHaveLength(1)
        await act(async () => {
          if (!refused) {
            useAppStore.setState({
              unifiedTabsByWorktree: { wt: [{ ...tab, viewMode: 'terminal' }] }
            })
          }
          answers.forEach((answer) =>
            answer({
              ok: true,
              result: refused ? { ok: false, code: 'tab_not_found' } : { ok: true, result: {} }
            })
          )
        })
        expect(hook.result.current.effectiveChatViewMode).toBe(refused)
      } else {
        expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe(
          flow === 'title-sibling' ? 'chat' : 'terminal'
        )
      }
      const before = writes.length
      await act(async () => {
        await inspectRuntimeTerminalProcess(id)
        acceptDesktopPresentationFrame(
          LOCAL_STRUCTURED_SESSION_OWNER,
          presentationFrame('wt', id, 'inc', {
            ...shellPresentation,
            version:
              ORCA_LAYOUT_OWNER_IS_MAIN && flow !== 'title-sibling' && flow !== 'legacy' ? 3 : 1
          })
        )
        await inspectRuntimeTerminalProcess(id)
      })
      expect(writes).toHaveLength(before)
      expect(useAppStore.getState().terminalLayoutsByTabId['actual-tab'].chatLeafId).toBe(
        flow === 'title-sibling' ? sibling : undefined
      )
      expect(useAppStore.getState().agentStatusByPaneKey).toBe(rows)
      localInspect.mockResolvedValue({
        foregroundProcess: 'codex',
        hasChildProcesses: true,
        presentation: {
          ...shellPresentation,
          version: 4,
          state: 'agent-in-front'
        }
      })
      await act(async () => {
        await inspectRuntimeTerminalProcess(id)
      })
      expect(hook.result.current.effectiveChatViewMode).toBe(
        flow === 'title-sibling' || (ORCA_LAYOUT_OWNER_IS_MAIN && refused)
      )
      expect(await sendRuntimePtyInputVerified(id, 'fg\r', 'driving')).toBe(true)
      expect(localWriteAccepted).toHaveBeenCalledTimes(1)
      if (flow === 'mounted') {
        await act(async () => {
          hook.result.current.handleToggleNativeChat()
        })
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          await act(async () => {
            useAppStore.setState({ unifiedTabsByWorktree: { wt: [{ ...tab, viewMode: 'chat' }] } })
            answers.forEach((answer) => answer({ ok: true, result: { ok: true, result: {} } }))
          })
        }
        expect(hook.result.current.effectiveChatViewMode).toBe(true)
      }
      hook.unmount()
      setLocalRuntimeCapabilitiesForTests(null)
      unsubscribe()
    }
  )
  it('delivers the same paid confirmation before the main callback and preserves legacy/unknown suppliers', async () => {
    const id = 'confirm-presentation'
    const observation = shellPresentation
    const confirm = vi.fn(async () => ({ foregroundProcess: 'zsh', presentation: observation }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this modern-only supplier is called with includePresentation; the one-argument overload is exercised separately.
    window.api.pty.confirmForegroundProcess = confirm as never
    const stop = subscribeDesktopPresentation(id, vi.fn())
    expect(await confirmRuntimeTerminalForegroundProcess(id)).toBe('zsh')
    expect(desktopPresentationForExit(id)).toBe('not-in-front')
    expect(localInspect).not.toHaveBeenCalled()
    window.api.pty.confirmForegroundProcess = vi.fn(async () => 'zsh')
    await confirmRuntimeTerminalForegroundProcess('legacy-confirm')
    expect(desktopPresentationForExit('legacy-confirm')).toBe('gone')
    localInspect.mockResolvedValue({
      foregroundProcess: null,
      hasChildProcesses: true,
      presentation: { ...observation, version: 2, state: undefined }
    })
    await inspectRuntimeTerminalProcess(id)
    await confirmRuntimeTerminalForegroundProcess(id)
    expect(desktopPresentationForExit(id)).toBeUndefined()
    type Confirmation = Awaited<ReturnType<typeof window.api.pty.confirmForegroundProcess>>
    let finish!: (value: Confirmation) => void
    const held = vi.fn(
      () =>
        new Promise<Confirmation>((resolve) => {
          finish = resolve
        })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: held resolves the opted-in overload's exact union; this flow never calls its old one-argument overload.
    window.api.pty.confirmForegroundProcess = held as never
    const stale = confirmRuntimeTerminalForegroundProcess(id)
    const staleInspection = inspectRuntimeTerminalProcess(id)
    acceptDesktopPresentationFrame(
      LOCAL_STRUCTURED_SESSION_OWNER,
      presentationFrame('confirmation', id, 'replacement')
    )
    finish({ foregroundProcess: 'zsh', presentation: observation })
    await Promise.all([stale, staleInspection])
    expect(desktopPresentationSnapshot(id)).toBeUndefined()
    acceptDesktopPresentationFrame(
      LOCAL_STRUCTURED_SESSION_OWNER,
      presentationFrame('confirmation', id, 'replacement', {
        support: 'legacy',
        incarnationId: 'replacement',
        version: 1
      })
    )
    expect(desktopPresentationSnapshot(id)?.incarnationId).toBe('replacement')
    expect(desktopPresentationForExit(id)).toBe('gone')
    for (const result of [null, { foregroundProcess: null }]) {
      const id = `failed-confirm-${result === null}`
      const failed = confirmRuntimeTerminalForegroundProcess(id)
      finish(result)
      await failed
      expect(desktopPresentationForExit(id)).toBeUndefined()
    }
    retractDesktopPresentations(LOCAL_STRUCTURED_SESSION_OWNER, 'confirmation')
    stop()
  })

  it.each([10, 100])(
    'retires %s exact delivery scopes without erasing direct authority',
    async (n) => {
      const id = `scopes-${n}`
      const listener = vi.fn()
      const stop = subscribeDesktopPresentation(id, listener)
      const presentation = shellPresentation
      localInspect.mockResolvedValue({
        foregroundProcess: 'zsh',
        hasChildProcesses: true,
        presentation
      })
      await inspectRuntimeTerminalProcess(id)
      const frame = (i: number, observed = true) =>
        presentationFrame(
          `scope-${i}`,
          `${id}-${i}`,
          'replacement',
          observed ? { ...presentation, incarnationId: 'replacement' } : undefined
        )
      for (let i = 0; i < n; i++) {
        acceptDesktopPresentationFrame(LOCAL_STRUCTURED_SESSION_OWNER, frame(i))
      }
      acceptDesktopPresentationFrame(LOCAL_STRUCTURED_SESSION_OWNER, frame(0), 'active')
      let valueVisits = 0
      const values = Map.prototype.values
      const valueSpy = vi.spyOn(Map.prototype, 'values').mockImplementation(function* (
        this: Map<unknown, unknown>
      ) {
        for (const value of values.call(this)) {
          valueVisits++
          yield value
        }
        return undefined
      })
      const keySpy = vi.spyOn(Map.prototype, 'keys')
      const memberSpy = vi.spyOn(Set.prototype, 'has')
      for (let i = 0; i < n; i++) {
        acceptDesktopPresentationFrame(LOCAL_STRUCTURED_SESSION_OWNER, frame(i, false))
      }
      acceptDesktopPresentationFrame(LOCAL_STRUCTURED_SESSION_OWNER, frame(0, false), 'active')
      subscribeDesktopPresentation(`${id}-0`, vi.fn())()
      for (let i = 0; i < n; i++) {
        if (i % 2) {
          retractDesktopPresentations(LOCAL_STRUCTURED_SESSION_OWNER, `scope-${i}`)
        } else {
          acceptDesktopPresentationFrame(LOCAL_STRUCTURED_SESSION_OWNER, { ...frame(i), tabs: [] })
        }
      }
      await inspectRuntimeTerminalProcess(`${id}-0`)
      expect(desktopPresentationSnapshot(`${id}-0`)).toBeUndefined()
      retractDesktopPresentations(LOCAL_STRUCTURED_SESSION_OWNER, 'scope-0', 'active')
      await inspectRuntimeTerminalProcess(`${id}-0`)
      expect(desktopPresentationSnapshot(`${id}-0`)).toEqual(presentation)
      expect(valueVisits).toBe(0)
      expect(keySpy).not.toHaveBeenCalled()
      expect(memberSpy.mock.calls.filter(([value]) => String(value).startsWith(id))).toHaveLength(
        n + 1 + n / 2
      )
      valueSpy.mockRestore()
      keySpy.mockRestore()
      memberSpy.mockRestore()
      expect(desktopPresentationSnapshot(id)).toEqual(presentation)
      expect(listener).toHaveBeenCalledTimes(1)
      stop()
    }
  )
})
