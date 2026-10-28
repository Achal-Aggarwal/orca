// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}
let root: Root
let host: HTMLDivElement
const launch = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  launch.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <TooltipProvider>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu
              entries={[entry]}
              model={{
                state: 'settled',
                rows: entry.rows,
                detection: {
                  detectedIds: ['codex'],
                  isLoading: false,
                  isRefreshing: false,
                  detectionFailed: false,
                  needsServerUpdate: false,
                  refresh: async () => ['codex']
                }
              }}
              runLaunch={launch}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  )
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('opens setup with a clicked chevron without launching, then dispatches its selected surface once', () => {
  const configure = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Configure Codex"]'
  )
  act(() => configure?.click())
  expect(launch).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Arguments')
  const terminal = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Open terminal'
  )
  act(() => terminal?.click())
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0]).toMatchObject([
    { agent: 'codex', kind: 'cli' },
    { agent: 'codex', surface: 'terminal', choices: {} }
  ])
})
it('launches the alternate search result once and closes the owning menu', () => {
  const input = document.querySelector('input')
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'astra low'
    )
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const alternate = document.querySelector<HTMLButtonElement>('button[aria-label="Open terminal"]')
  act(() => alternate?.click())
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0][1]).toMatchObject({
    surface: 'terminal',
    choices: { model: 'astra', options: { effort: 'low' } }
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('keeps the default button on the right and plain clicks free of setup overrides', () => {
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')
  const routes = [...(row?.querySelectorAll<HTMLButtonElement>('button[data-size="xs"]') ?? [])]
  expect(routes.map((button) => button.textContent)).toEqual(['Terminal', 'Chat'])
  expect(routes[1].getAttribute('data-variant')).toBe('secondary')
  act(() => row?.click())
  expect(launch).toHaveBeenCalledExactlyOnceWith(entry.rows[0], undefined)
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('dispatches the explicit Terminal button with the keyboard once', () => {
  const terminal = document.querySelector<HTMLButtonElement>('button[aria-label="Open terminal"]')
  act(() => {
    terminal?.focus()
    terminal?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ agent: 'codex', kind: 'cli' }),
    undefined
  )
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('lets the chevron return keyboard focus to its row without opening or launching', () => {
  const configure = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Configure Codex"]'
  )
  act(() => {
    configure?.focus()
    configure?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  })
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
  expect(document.body.textContent).not.toContain('Arguments')
  expect(launch).not.toHaveBeenCalled()
})
