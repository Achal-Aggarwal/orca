// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneController } from '../terminal-pane/use-terminal-pane-controller'
import type { PtyTransport } from '../terminal-pane/pty-transport-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { emptyCrew } from '../../../../shared/orchestration-crew'
import { TooltipProvider } from '../ui/tooltip'
import { TerminalCrewPortals } from './TerminalCrewPortals'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ terminalLayoutsByTabId: {} })
}))
vi.mock('./use-terminal-crew-identity', () => ({
  useTerminalCrewIdentity: () => ({ target: { kind: 'local' }, party: 'term_self' })
}))
vi.mock('../native-chat/use-orchestration-crew', () => ({
  useOrchestrationCrew: () => {
    const snapshot = emptyCrew('ok')
    snapshot.sections.managing.push({
      partyKey: 'worker',
      role: 'worker',
      label: 'Worker',
      agentKind: 'codex',
      status: 'working',
      task: { title: 'Inspect', state: 'dispatched' },
      sendAddress: 'term_worker'
    })
    return snapshot
  }
}))
vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationCrewAgent: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.clearAllMocks()
})

function fixture(acceptance: boolean | Promise<boolean> | undefined) {
  let ptyId = 'pty-captured'
  const container = document.createElement('div')
  const input = document.createElement('textarea')
  input.value = 'existing suffix'
  input.setSelectionRange(8, 8)
  container.append(input)
  document.body.append(container)
  // SAFETY: the mounted portal consumes only this pane's identity and its portal container.
  const pane = { id: 7, leafId: '11111111-1111-4111-8111-111111111111', container } as ManagedPane
  const sendInput = vi.fn(() => true)
  const accepted = vi.fn(async () => acceptance ?? true)
  // SAFETY: the portal/drop validator/paste writer consume only the listed transport surface.
  const transport = {
    getPtyId: () => ptyId,
    isConnected: () => true,
    sendInput,
    ...(acceptance === undefined ? {} : { sendInputAccepted: accepted })
  } as unknown as PtyTransport
  const transports = new Map([[pane.id, transport]])
  const manager = {
    getPanes: () => [pane],
    setActivePane: vi.fn((id: number) => {
      if (id === pane.id) {
        input.focus()
      }
    })
  }
  // SAFETY: TerminalCrewPortals reads only the controller's pane/transport identity and view-mode fields below.
  const controller = {
    tabId: 'tab',
    worktreeId: 'workspace',
    managerRef: { current: manager },
    paneTransportsRef: { current: transports },
    managedPanes: [pane],
    effectiveChatViewMode: false,
    chatPane: null
  } as unknown as TerminalPaneController
  render(
    <TooltipProvider>
      <TerminalCrewPortals controller={controller} />
    </TooltipProvider>
  )
  fireEvent.click(within(container).getByRole('button', { name: 'Show crew: 1 workers' }))
  const mention = () =>
    fireEvent.click(within(container).getByRole('button', { name: 'Mention all' }))
  return {
    pane,
    input,
    mention,
    manager,
    transports,
    transport,
    accepted,
    sendInput,
    replacePty: () => {
      ptyId = 'pty-replaced'
    }
  }
}

it('restores the captured pane focus after acceptance, preserves caret/no Enter, and uses the legacy input fallback', async () => {
  for (const acceptance of [true, undefined]) {
    const test = fixture(acceptance)
    expect(document.activeElement).not.toBe(test.input)
    await act(async () => test.mention())
    expect(test.manager.setActivePane).toHaveBeenCalledExactlyOnceWith(7)
    expect(document.activeElement).toBe(test.input)
    expect(test.input.selectionStart).toBe(8)
    expect(test.input.value).toBe('existing suffix')
    const writer = acceptance === undefined ? test.sendInput : test.accepted
    expect(writer).toHaveBeenCalledExactlyOnceWith('Worker (Orca agent term_worker) ', 'driving')
    expect(toast.error).not.toHaveBeenCalled()
    cleanup()
    document.body.replaceChildren()
    vi.clearAllMocks()
  }
})

it('shows one refusal toast and never focuses replaced captured pane, PTY or transport after an asynchronous write', async () => {
  for (const rejects of [false, true]) {
    const refused = fixture(false)
    if (rejects) {
      refused.accepted.mockRejectedValueOnce(new Error('transport rejected'))
    }
    await act(async () => refused.mention())
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(refused.manager.setActivePane).not.toHaveBeenCalled()
    cleanup()
    document.body.replaceChildren()
    vi.clearAllMocks()
  }
  for (const kind of ['pane', 'pty', 'transport'] as const) {
    let finish!: (accepted: boolean) => void
    const test = fixture(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    act(() => test.mention())
    if (kind === 'pane') {
      test.pane.leafId = parsePaneKey('tab:22222222-2222-4222-8222-222222222222')!.leafId
    }
    if (kind === 'pty') {
      test.replacePty()
    }
    if (kind === 'transport') {
      test.transports.set(test.pane.id, { ...test.transport })
    }
    await act(async () => finish(true))
    expect(test.manager.setActivePane).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(test.accepted).toHaveBeenCalledTimes(1)
    cleanup()
    document.body.replaceChildren()
    vi.clearAllMocks()
  }
})
