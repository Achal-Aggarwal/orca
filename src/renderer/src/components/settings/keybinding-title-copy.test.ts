import { afterEach, describe, expect, it } from 'vitest'
import {
  agentTabActionId,
  getKeybindingDefinition,
  type KeybindingActionId,
  type KeybindingDefinition
} from '../../../../shared/keybindings'
import { i18n } from '@/i18n/i18n'
import { localizeKeybindingDefinition } from './keybinding-title-copy'

function definition(actionId: KeybindingActionId): KeybindingDefinition {
  const found = getKeybindingDefinition(actionId)
  if (!found) {
    throw new Error(`missing ${actionId}`)
  }
  return found
}

describe('localizeKeybindingDefinition', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('localizes built-in titles, keeps English searchable, and leaves plugin titles alone', async () => {
    await i18n.changeLanguage('ko')
    const quickOpen = definition('worktree.quickOpen')

    const localized = localizeKeybindingDefinition(quickOpen)
    expect(localized.title).toBe('파일로 이동')
    expect(localized.group).toBe('글로벌')
    expect(localized.searchKeywords).toEqual(expect.arrayContaining(['Go to File', 'Global']))
    expect(localizeKeybindingDefinition(definition(agentTabActionId('claude'))).title).toBe(
      '새 Claude 탭'
    )

    const plugin: KeybindingDefinition = {
      ...quickOpen,
      id: 'plugin:orca-samples.tasks/open',
      title: 'Open Tasks — Tasks',
      group: 'Plugins'
    }
    expect(localizeKeybindingDefinition(plugin)).toBe(plugin)
  })
})
