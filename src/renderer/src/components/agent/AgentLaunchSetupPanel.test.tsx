// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import { agentPickerDraft, type AgentPickerEntry } from '../../../../shared/agent-launch-picker'

const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  rows: [{ agent: 'claude', kind: 'terminal' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'terminal',
  terminal: { permissionMode: 'ask' },
  structured: { permissionMode: 'ask' },
  arguments: '--permission-mode plan --add-dir docs',
  catalog: { origin: 'unknown' }
}
let root: Root
let host: HTMLDivElement
const onUse = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onUse.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('shows the Arguments-owned value in disabled Permissions; removing its chip enables the menu and preserves other CLI Arguments', () => {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={entry} onUse={onUse} />
      </TooltipProvider>
    )
  )
  const permission = () => host.querySelector<HTMLButtonElement>('button[aria-label="Permissions"]')
  expect(permission()?.disabled).toBe(true)
  expect(permission()?.textContent).toContain('--permission-mode plan')
  expect(host.querySelector('input')?.value).toBe('--add-dir docs')
  act(() =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Remove --permission-mode plan"]')
      ?.click()
  )
  expect(permission()?.disabled).toBe(false)
  expect(host.querySelector('input')?.value).toBe('--add-dir docs')
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open terminal')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ surface: 'terminal', arguments: '--add-dir docs' })
  )
  expect(entry.arguments).toBe('--permission-mode plan --add-dir docs')
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Reset to default')
      ?.click()
  )
  expect(permission()?.disabled).toBe(true)
})

it('leaves chat Permissions enabled even with launch-owned raw CLI permission text', () => {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={entry}
          initial={{ ...agentPickerDraft(entry, 'chat'), arguments: '--permission-mode plan' }}
          onUse={onUse}
        />
      </TooltipProvider>
    )
  )
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Permissions"]')?.disabled).toBe(
    false
  )
  expect(host.querySelector('button[aria-label="Remove --permission-mode plan"]')).not.toBeNull()
})

it('shows the remembered chat defaults while keeping an untouched configured launch sparse', () => {
  const chat: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    defaultSurface: 'chat',
    arguments: '--add-dir docs',
    structured: { model: 'astra', options: { effort: 'low' }, permissionMode: 'ask' },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
      ]
    }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={chat} onUse={onUse} />
      </TooltipProvider>
    )
  )
  const selections = [...host.querySelectorAll('[role="combobox"]')].map(
    (control) => control.textContent
  )
  expect(selections).toEqual(['Agent default · Astra', 'Default · Low', 'Agents defaults · Ask'])
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open chat')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith({
    agent: 'codex',
    surface: 'chat',
    choices: {},
    arguments: undefined
  })
})
