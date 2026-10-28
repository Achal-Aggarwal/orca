// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import {
  agentPickerDraft,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

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
  expect(host.querySelector('input[id^="agent-arguments-"]')?.value).toBe('--add-dir docs')
  act(() =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Remove --permission-mode plan"]')
      ?.click()
  )
  expect(permission()?.disabled).toBe(false)
  expect(host.querySelector('input[id^="agent-arguments-"]')?.value).toBe('--add-dir docs')
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open terminal')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ surface: 'terminal', arguments: '--add-dir docs' })
  )
  expect(entry.arguments).toBe('--permission-mode plan --add-dir docs')
  expect(host.textContent).not.toContain('Reset to default')
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
  expect(selections).toEqual(['', 'Low', 'Ask'])
  expect(host.textContent).not.toMatch(/Agents? defaults?|Reset to default/)
  expect(host.querySelector('[cmdk-item][data-current="true"]')?.textContent).toBe('Astra')
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

it('keeps unknown default controls disabled in place, then selects host-resolved values without writing overrides', () => {
  const pending: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    defaultSurface: 'chat',
    arguments: undefined,
    structured: {},
    defaultsPending: true
  }
  const render = (value: AgentPickerEntry) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={value} onUse={onUse} />
        </TooltipProvider>
      )
    )
  render(pending)
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')?.disabled).toBe(
    true
  )
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Permissions"]')?.disabled).toBe(
    true
  )
  expect(host.querySelector('[cmdk-item][data-current="true"]')).toBeNull()
  const settled: AgentPickerEntry = {
    ...pending,
    defaultsPending: false,
    structured: { permissionMode: 'ask' },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      models: [
        {
          id: 'host-model',
          label: 'Host model',
          isDefault: true,
          defaultEffort: 'low',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    }
  }
  render(settled)
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')?.disabled).toBe(
    false
  )
  expect(host.querySelector('[cmdk-item][data-current="true"]')?.textContent).toBe('Host model')
  expect(host.querySelector('button[aria-label="Reasoning effort"]')?.textContent).toBe('Low')
  expect(host.querySelector('button[aria-label="Permissions"]')?.textContent).toBe('Ask')
  expect(host.textContent).not.toMatch(/Agents? defaults?|Reset to default/)
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open chat')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(agentPickerDraft(settled))

  render({ ...settled, catalog: { origin: 'unknown' }, structured: { permissionMode: 'ask' } })
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')?.disabled).toBe(
    true
  )
  expect(
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Open chat')
      ?.disabled
  ).toBe(false)
})

it('returns to concrete default model, effort and permission values by selecting them directly', () => {
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    defaultSurface: 'chat',
    arguments: undefined,
    structured: { model: 'astra', options: { effort: 'low' }, permissionMode: 'ask' },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        {
          id: 'astra',
          label: 'Astra',
          isDefault: true,
          defaultEffort: 'low',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        },
        {
          id: 'other',
          label: 'Other',
          isDefault: false,
          defaultEffort: 'low',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={own} onUse={onUse} />
      </TooltipProvider>
    )
  )
  const model = (name: string) =>
    act(() =>
      [...host.querySelectorAll<HTMLElement>('[cmdk-item]')]
        .find((row) => row.textContent === name)
        ?.click()
    )
  model('Other')
  model('Astra')
  const select = (label: string, value: string) => {
    fireEvent.keyDown(host.querySelector(`button[aria-label="${label}"]`)!, { key: 'ArrowDown' })
    fireEvent.click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (row) => row.textContent === value
      )!
    )
  }
  select('Reasoning effort', 'High')
  select('Reasoning effort', 'Low')
  select('Permissions', 'Full access')
  select('Permissions', 'Ask')
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open chat')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      choices: { model: 'astra', options: { effort: 'low' }, permissionMode: 'ask' }
    })
  )
  expect(host.textContent).not.toMatch(/Agents? defaults?|Reset to default/)
})

it('searches current and supplied legacy models, keeps unknown explicit choices, and hides CLI Arguments for chat-only entries', () => {
  const catalog = {
    origin: 'probe' as const,
    fetchedAt: 1,
    models: [
      { id: 'current-model', label: 'Current model', isDefault: true, efforts: [] },
      {
        id: 'retired',
        label: 'Retired model',
        isDefault: false,
        efforts: [],
        isLegacy: true as const
      }
    ]
  }
  const chat: AgentPickerEntry = { ...entry, surfaces: ['chat'], defaultSurface: 'chat', catalog }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={chat}
          initial={{ ...agentPickerDraft(chat), choices: { model: 'private-model' } }}
          onUse={onUse}
        />
      </TooltipProvider>
    )
  )
  expect(host.querySelector('input[id^="agent-arguments-"]')).toBeNull()
  expect(host.textContent).not.toContain('Applies only to CLI launches.')
  expect(host.querySelector('[cmdk-item][data-current="true"]')?.textContent).toBe('private-model')
  expect(host.textContent).toContain('Legacy models')
  expect(host.textContent).not.toContain('Retired model')
  const search = host.querySelector('input[aria-label="Search models"]')!
  fireEvent.change(search, { target: { value: 'Retired' } })
  expect(host.textContent).toContain('Retired model')
  act(() =>
    [...host.querySelectorAll<HTMLElement>('[cmdk-item]')]
      .find((row) => row.textContent === 'Retired model')
      ?.click()
  )
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open chat')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ choices: { model: 'retired' } })
  )
})

it.each(['chat', 'terminal'] as const)(
  'uses the %s default exactly once from Enter in CLI Arguments, keeping CLI changes out of Chat intent',
  (surface) => {
    const own = { ...entry, defaultSurface: surface }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            entry={own}
            initial={{
              ...agentPickerDraft(own),
              choices: { model: 'opus', permissionMode: 'ask' }
            }}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
    const input = host.querySelector('input[id^="agent-arguments-"]')!
    fireEvent.change(input, { target: { value: '--model haiku --dangerously-skip-permissions' } })
    for (const way of ['chat', 'terminal'] as const) {
      onUse.mockClear()
      act(() =>
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === (way === 'chat' ? 'Open chat' : 'Open terminal'))
          ?.click()
      )
      expect(onUse).toHaveBeenCalledOnce()
      const launch = agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
      if (way === 'chat') {
        expect(launch).toEqual({ sessionOptions: { model: 'opus', permissionMode: 'ask' } })
      } else {
        expect(launch.agentArgs).toContain('--dangerously-skip-permissions')
      }
    }
    onUse.mockClear()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onUse).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ surface, choices: { model: 'opus', permissionMode: 'ask' } })
    )
  }
)
