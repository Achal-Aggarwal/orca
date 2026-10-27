import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { MobileAgentLaunchPicker } from './MobileAgentLaunchPicker'
import { MobileAgentPickerPermissionFields } from './MobileAgentPickerPermissionFields'
import { agentPickerDraft } from '../../../src/shared/agent-launch-picker'
import type { AgentPickerEntry } from '../../../src/shared/agent-launch-picker'

vi.mock('react-native', () => ({
  View: 'div',
  Text: 'span',
  TextInput: 'input',
  Pressable: 'button',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', ChevronRight: 'Icon' }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  arguments: '--search',
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}

it('search launches the default or alternate once; chevron opens an editable setup with default on the right', async () => {
  const onUse = vi.fn()
  let view: ReactTestRenderer | undefined
  await act(async () => {
    view = create(createElement(MobileAgentLaunchPicker, { entries: [entry], onUse }))
  })
  if (!view) {
    throw new Error('Picker did not mount')
  }
  const root = view.root
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Search agents and setups' })
      .props.onChangeText('astra low')
  })
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Search agents and setups' }).props.onSubmitEditing()
  })
  expect(onUse).toHaveBeenCalledExactlyOnceWith({
    agent: 'codex',
    surface: 'chat',
    choices: { model: 'astra', options: { effort: 'low' } }
  })
  onUse.mockClear()
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Open terminal' }).props.onPress()
  })
  expect(onUse).toHaveBeenCalledExactlyOnceWith({
    agent: 'codex',
    surface: 'terminal',
    choices: { model: 'astra', options: { effort: 'low' } }
  })
  onUse.mockClear()
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Search agents and setups' }).props.onChangeText('')
  })
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Configure Codex' }).props.onPress()
  })
  expect(onUse).not.toHaveBeenCalled()
  const buttons = root.findAllByType('button').filter((button) => button.props.accessibilityState)
  expect(buttons.slice(-2).map((button) => button.findByType('span').props.children)).toEqual([
    'Open terminal',
    'Open chat'
  ])
  const args = root.findByProps({ accessibilityLabel: 'Arguments' })
  expect(args.props.value).toBe('--search')
  await act(async () => {
    args.props.onChangeText('')
  })
  await act(async () => {
    root
      .findAllByType('button')
      .find((button) =>
        button.findAllByType('span').some((text) => text.props.children === 'Open terminal')
      )
      ?.props.onPress()
  })
  expect(onUse).toHaveBeenCalledExactlyOnceWith({
    agent: 'codex',
    surface: 'terminal',
    choices: {},
    arguments: null
  })
  await act(async () => {
    view?.unmount()
  })
})

it('native Permissions reflect Arguments ownership only for terminals and chip removal produces a launch-only override', async () => {
  const ownEntry: AgentPickerEntry = {
    ...entry,
    arguments: '--ask-for-approval never --search'
  }
  const onChange = vi.fn()
  let view: ReactTestRenderer | undefined
  const props = {
    entry: ownEntry,
    draft: agentPickerDraft(ownEntry, 'terminal'),
    showArguments: true,
    onChange
  }
  await act(async () => {
    view = create(createElement(MobileAgentPickerPermissionFields, props))
  })
  if (!view) {
    throw new Error('Permission fields did not mount')
  }
  expect(
    view.root.findAllByType('button').find((button) => button.props.accessibilityState?.disabled)
      ?.props.disabled
  ).toBe(true)
  expect(view.root.findByProps({ accessibilityLabel: 'Arguments' }).props.value).toBe('--search')
  await act(async () => {
    view?.root
      .findByProps({ accessibilityLabel: 'Remove --ask-for-approval never' })
      .props.onPress()
  })
  expect(onChange).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ arguments: '--search' })
  )
  await act(async () => {
    view?.update(
      createElement(MobileAgentPickerPermissionFields, {
        ...props,
        draft: agentPickerDraft(ownEntry, 'chat')
      })
    )
  })
  expect(view.root.findAllByType('button').every((button) => !button.props.disabled)).toBe(true)
  expect(ownEntry.arguments).toBe('--ask-for-approval never --search')
  await act(async () => {
    view?.unmount()
  })
})
