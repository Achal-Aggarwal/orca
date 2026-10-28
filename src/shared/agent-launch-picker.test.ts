import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  agentPickerDraft,
  agentPickerHydrationQueue,
  agentPickerEntryOptions,
  agentPickerSessionOptions,
  agentPickerEffectiveChoices,
  agentPickerButtonOrder,
  searchAgentPickerSetups,
  editAgentPickerDraft,
  editAgentPickerArguments,
  type AgentPickerEntry
} from './agent-launch-picker'

const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: { permissionMode: 'ask' },
  structured: { model: 'astra', options: { effort: 'high' }, permissionMode: 'ask' },
  arguments: '--add-dir docs',
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      {
        id: 'astra',
        label: 'Astra',
        isDefault: true,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra high' }
        ]
      }
    ]
  }
}

describe('shared agent launch picker', () => {
  it('keeps ordinary launch unconfigured and the existing default on the right', () => {
    expect(agentPickerDraft(entry)).toEqual({
      agent: 'codex',
      surface: 'chat',
      choices: {},
      arguments: undefined
    })
    expect(agentPickerEffectiveChoices(entry, agentPickerDraft(entry))).toEqual(entry.structured)
    expect(agentPickerEffectiveChoices(entry, agentPickerDraft(entry, 'terminal'))).toEqual(
      entry.terminal
    )
    expect(agentPickerButtonOrder(entry)).toEqual(['terminal', 'chat'])
    expect(agentPickerButtonOrder({ ...entry, defaultSurface: 'terminal' })).toEqual([
      'chat',
      'terminal'
    ])
  })
  it('derives setup matches from every query word, folds extra high and leaves plain agent searches plain', () => {
    expect(searchAgentPickerSetups([entry], 'codex')).toEqual([])
    expect(searchAgentPickerSetups([entry], 'astra low')[0]?.choices).toEqual({
      model: 'astra',
      options: { effort: 'low' }
    })
    expect(
      searchAgentPickerSetups([entry], 'codex astra extra high')[0]?.choices.options?.effort
    ).toBe('xhigh')
    expect(searchAgentPickerSetups([entry], 'astra unsupported')).toEqual([])
    expect(searchAgentPickerSetups([entry], 'astra')).toHaveLength(1)
  })
  it('keeps unknown saved models launchable while current search excludes a classified legacy model', () => {
    const legacy = {
      ...entry,
      catalog: {
        origin: 'probe' as const,
        fetchedAt: 1,
        models: [
          {
            id: 'retired',
            label: 'Retired',
            isDefault: false,
            efforts: [],
            isLegacy: true as const
          }
        ]
      }
    }
    expect(searchAgentPickerSetups([legacy], 'retired')).toEqual([])
    const draft = editAgentPickerDraft(agentPickerDraft(entry), { model: 'my-private-alias' })
    expect(editAgentPickerDraft(draft, { permissionMode: 'own' }).choices).toEqual({
      model: 'my-private-alias',
      permissionMode: 'own'
    })
  })
  it('reconciles deliberate Arguments edits once and preserves explicit empty versus inheritance', () => {
    const draft = editAgentPickerArguments(
      agentPickerDraft(entry, 'terminal'),
      '--model astra --add-dir docs'
    )
    expect(draft.choices.model).toBe('astra')
    expect(draft.arguments).toBe('--add-dir docs')
    expect(editAgentPickerArguments(draft, '').arguments).toBeNull()
    expect(agentPickerDraft(entry).arguments).toBeUndefined()
  })
  it('uses live effort facts for an opaque model and emits an independent effort', () => {
    expect(
      agentPickerEntryOptions(entry, 'astra', 'terminal').find((option) => option.id === 'effort')
        ?.kind
    ).toMatchObject({
      type: 'select',
      choices: entry.catalog.origin !== 'unknown' ? entry.catalog.models[0].efforts : []
    })
    expect(agentPickerSessionOptions({ options: { effort: 'low' } })).toEqual({ effort: 'low' })
  })
  it('bounds suggestions without mutating the inventory or creating saved setups', () => {
    const large = {
      ...entry,
      catalog: {
        origin: 'probe' as const,
        fetchedAt: 1,
        models: Array.from({ length: 80 }, (_, id) => ({
          id: `astra-${id}`,
          label: `Astra ${id}`,
          isDefault: false,
          efforts: []
        }))
      }
    }
    expect(searchAgentPickerSetups([large], 'astra')).toHaveLength(8)
    expect(large.catalog.models).toHaveLength(80)
  })
})

it('prioritizes the selected pending catalog and reads each offered agent only once', () => {
  let selected: AgentPickerEntry['agent'] | undefined
  const entries = [
    entry,
    { ...entry, agent: 'claude' as const },
    { ...entry, agent: 'gemini' as const },
    { ...entry, agent: 'grok' as const, surfaces: [] }
  ]
  const next = agentPickerHydrationQueue(entries, () => selected)
  expect(next()).toBe(0)
  selected = 'gemini'
  expect(next()).toBe(2)
  expect(next()).toBe(1)
  expect(next()).toBeUndefined()
})
it('retains a model named by a captured Claude init and honors its disabled fast mode', () => {
  const initSchema = z.object({
    frame: z.object({
      type: z.literal('system'),
      subtype: z.literal('init'),
      model: z.string(),
      fast_mode_disabled_reason: z.literal('sdk_opt_in_required')
    })
  })
  const capture = readFileSync(
    new URL('../main/claude/__fixtures__/claude-adapter-capture-fold.jsonl', import.meta.url),
    'utf8'
  )
  const init = capture
    .trim()
    .split('\n')
    .map((line) => initSchema.safeParse(JSON.parse(line)))
    .find((result) => result.success)
  if (!init?.success) {
    throw new Error('Captured init is missing')
  }
  const model = init.data.frame.model
  const captured: AgentPickerEntry = {
    ...entry,
    agent: 'claude',
    catalog: {
      origin: 'live-session',
      fetchedAt: 1,
      fastModeSupport: { supported: false, reason: init.data.frame.fast_mode_disabled_reason },
      models: [{ id: model, label: model, isDefault: false, efforts: [], effortsKnown: false }]
    }
  }
  expect(
    agentPickerEntryOptions(captured, model, 'chat').some((option) => option.id === 'fastMode')
  ).toBe(false)
  expect(editAgentPickerDraft(agentPickerDraft(captured), { model }).choices.model).toBe(model)
})
