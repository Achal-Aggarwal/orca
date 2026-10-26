import { describe, expect, it } from 'vitest'
import {
  nativeChatModelPillLabel,
  nativeChatOptionValuesLabel,
  nativeChatSessionChoiceLabel,
  sayNativeChatSessionOptionEnglish as say
} from './native-chat-session-option-labels'
import type { SessionOptionDescriptor } from './native-chat/input/native-chat-session-options'

function modelDescriptor(
  valueSource: SessionOptionDescriptor['valueSource'],
  currentValue?: string
): SessionOptionDescriptor {
  return {
    id: 'model',
    label: 'Model',
    valueSource,
    transport: 'catalog',
    settable: true,
    kind: {
      type: 'select',
      ...(currentValue ? { currentValue } : {}),
      choices: [{ value: 'grok-4.5', label: 'Grok 4.5' }]
    }
  }
}

describe('nativeChatModelPillLabel', () => {
    expect(nativeChatModelPillLabel(modelDescriptor('reported', 'grok-build'), say)).toBe(
      'grok-build'
    )
  })
})

describe('nativeChatSessionChoiceLabel for speed', () => {
  it('names Standard only inside the speed choice', () => {
    expect(
      nativeChatSessionChoiceLabel({ value: 'default', label: 'Default' }, say, 'serviceTier')
    ).toBe('Standard')
    expect(
      nativeChatSessionChoiceLabel({ value: 'default', label: 'Ask first' }, say, 'mode')
    ).toBe('Ask first')
  })
})

describe('nativeChatOptionValuesLabel', () => {
  function speedDescriptor(currentValue: string): SessionOptionDescriptor {
    return {
      id: 'serviceTier',
      label: 'Speed',
      valueSource: 'reported',
      transport: 'agent-session',
      settable: true,
      kind: {
        type: 'select',
        currentValue,
        choices: [
          { value: 'default', label: 'Standard' },
          { value: 'priority', label: 'Fast' },
          { value: 'ultrafast', label: 'Ultrafast' }
        ]
      }
    }
  }

  it('names a faster tier and leaves Standard out, as Fast off was', () => {
    expect(nativeChatOptionValuesLabel([speedDescriptor('ultrafast')], say)).toBe('Ultrafast')
    expect(nativeChatOptionValuesLabel([speedDescriptor('default')], say)).toBe('')
  })

  it('shortens effort levels after the model', () => {
    const effort: SessionOptionDescriptor = {
      id: 'effort',
      label: 'Reasoning effort',
      valueSource: 'reported',
      transport: 'catalog',
      settable: true,
      kind: { type: 'select', currentValue: 'xhigh', choices: [{ value: 'xhigh', label: 'xhigh' }] }
    }
    expect(nativeChatOptionValuesLabel([effort], say)).toBe('XHigh')
  })
})
