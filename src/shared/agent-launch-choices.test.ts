import { describe, expect, it, vi } from 'vitest'
import * as choiceArgs from './agent-choice-args'
import { normalizeAgentModelOptionChoices } from './agent-launch-choices'
import { reconcileAgentChoiceArgs } from './agent-choice-reconciliation'
import { resolveAgentChoiceLayers } from './agent-choice-layers'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import { agentLaunchNeedsPreparedCommand } from './agent-launch-preferences'

const keys = new Set(['model', 'effort', 'permissionMode'])
const load = (agent: 'claude' | 'codex', userArgs: string) =>
  reconcileAgentChoiceArgs({ agent, userArgs, choices: {}, mode: 'load', keys })

describe('dedicated agent choices', () => {
  it.each([
    ['-c modelx', undefined, false],
    ['--config=modelx', undefined, false],
    ['-c model_reasoning_effortx', undefined, false],
    ['-c model=value', { model: 'value' }, true],
    ['-c model_reasoning_effort=low', { options: { effort: 'low' } }, true],
    ['-c model=42', undefined, true]
  ] as const)('requires a config assignment for %s ownership', (userArgs, choices, owned) => {
    const migrated = load('codex', userArgs)
    const patch = { model: 'gpt-5.5', options: { effort: 'high' } }
    const edited = reconcileAgentChoiceArgs({
      agent: 'codex',
      userArgs,
      choices: {},
      mode: 'choice-edit',
      keys,
      patch
    })
    const projected = projectAgentLaunchProfile(
      'codex',
      { agentPermissionDefault: 'own' },
      { target: 'terminal', userArgs, choices: patch }
    )
    expect.soft(migrated).toEqual(choices ? { userArgs: '', choices } : { userArgs, choices: {} })
    expect.soft(edited).toEqual({ userArgs: owned ? '' : userArgs, choices: patch })
    expect(projected.args).toBe(
      ['-m gpt-5.5 -c model_reasoning_effort=high', owned ? '' : userArgs].filter(Boolean).join(' ')
    )
  })

  it('bounds range comparisons and copied bytes on repeated-flag choice edits', () => {
    const analyze = choiceArgs.analyzeAgentChoiceArgs
    const slice = String.prototype.slice
    const join = Array.prototype.join
    let cutting = false
    let work = { rangeEndpointReads: 0, copiedBytes: 0 }
    const sliceSpy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start,
      end
    ) {
      const result = slice.call(this, start, end)
      if (cutting) {
        work.copiedBytes += result.length
      }
      return result
    })
    const joinSpy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator
    ) {
      const result = join.call(this, separator)
      if (cutting) {
        work.copiedBytes += result.length
      }
      return result
    })
    const analyzeSpy = vi
      .spyOn(choiceArgs, 'analyzeAgentChoiceArgs')
      .mockImplementation((...args) => {
        const analysis = analyze(...args)
        return {
          ...analysis,
          cut: (selected) => {
            const measured = selected.map((entry) => ({
              ...entry,
              get start() {
                work.rangeEndpointReads++
                return entry.start
              },
              get end() {
                work.rangeEndpointReads++
                return entry.end
              }
            }))
            cutting = true
            try {
              return analysis.cut(measured)
            } finally {
              cutting = false
            }
          }
        }
      })
    const measure = (count: number) => {
      const userArgs = `--append-system-prompt before ${'--model opus --append-system-prompt keep '.repeat(count)}--append-system-prompt after`
      work = { rangeEndpointReads: 0, copiedBytes: 0 }
      expect(
        reconcileAgentChoiceArgs({
          agent: 'claude',
          userArgs,
          choices: { model: 'opus' },
          mode: 'choice-edit',
          keys,
          patch: { model: 'sonnet' }
        })
      ).toEqual({
        userArgs: `--append-system-prompt before ${' --append-system-prompt keep '.repeat(count)}--append-system-prompt after`,
        choices: { model: 'sonnet' }
      })
      return { count, inputBytes: userArgs.length, ...work }
    }
    try {
      const small = measure(128)
      const large = measure(1280)
      console.info('choice-edit cut work', { small, large })
      expect(small.rangeEndpointReads).toBeGreaterThan(small.count)
      expect(small.copiedBytes).toBeGreaterThan(0)
      expect(large.rangeEndpointReads).toBeLessThanOrEqual(small.rangeEndpointReads * 12)
      expect(large.copiedBytes).toBeLessThanOrEqual(small.copiedBytes * 12)
      expect(large.rangeEndpointReads).toBeLessThan(large.count * 64)
      expect(large.copiedBytes).toBeLessThan(large.inputBytes * 20)
    } finally {
      analyzeSpy.mockRestore()
      joinSpy.mockRestore()
      sliceSpy.mockRestore()
    }
  })

  it('retains independent options and bounded opaque model ids without discovery', () => {
    expect(normalizeAgentModelOptionChoices({ options: { effort: 'high' } })).toEqual({
      options: { effort: 'high' }
    })
    expect(normalizeAgentModelOptionChoices({ model: 'retired-unlisted-id' })).toEqual({
      model: 'retired-unlisted-id'
    })
    expect(normalizeAgentModelOptionChoices({ options: { model: 'other' } })).toBeUndefined()
    expect(normalizeAgentModelOptionChoices({ model: 'x'.repeat(513) })).toBeUndefined()
  })

  it('lifts a complete tuple atomically and keeps surviving raw bytes', () => {
    expect(
      load('claude', '--model saved-unlisted-id  --effort high --permission-mode auto')
    ).toEqual({
      userArgs: '',
      choices: { model: 'saved-unlisted-id', options: { effort: 'high' }, permissionMode: 'auto' }
    })
    expect(load('codex', '-c model=opus --search -c model_reasoning_effort=high')).toEqual({
      userArgs: '--search',
      choices: { model: 'opus', options: { effort: 'high' } }
    })
    expect(load('claude', '--effort high')).toEqual({
      userArgs: '',
      choices: { options: { effort: 'high' } }
    })
    expect(load('claude', '--model opus --append-system-prompt "keep  spacing"').userArgs).toBe(
      '--append-system-prompt "keep  spacing"'
    )
  })

  it('keeps duplicates, operands, uncertain regions and unproved TOML literal', () => {
    for (const text of [
      '-m old --model new',
      '-m old -m old',
      '-m old -c model=new',
      '-c model=42',
      '-c model=true',
      `-c 'model="foo"'`,
      '-- --model other',
      '--new-unknown-option --model other',
      '--model'
    ]) {
      expect(load('codex', text), text).toEqual({ userArgs: text, choices: {} })
    }
    for (const text of [
      '--append-system-prompt "--model=other"',
      '--system-prompt "--model sonnet"',
      '--model op\\ us',
      "--model 'opus'"
    ]) {
      expect(load('claude', text), text).toEqual({ userArgs: text, choices: {} })
    }
    expect(load('codex', '-m old --model new -c model_reasoning_effort=high')).toEqual({
      userArgs: '-m old --model new',
      choices: { options: { effort: 'high' } }
    })
  })

  it('distinguishes load conflicts, deliberate edits and independent option removal', () => {
    const input = {
      agent: 'claude' as const,
      userArgs: '--model sonnet --effort high',
      choices: { model: 'opus', options: { effort: 'high' } },
      keys
    }
    expect(reconcileAgentChoiceArgs({ ...input, mode: 'load' })).toEqual({
      userArgs: '--model sonnet',
      choices: input.choices
    })
    expect(reconcileAgentChoiceArgs({ ...input, mode: 'arguments-edit' }).choices.model).toBe(
      'sonnet'
    )
    expect(
      reconcileAgentChoiceArgs({ ...input, mode: 'choice-edit', patch: { model: null } })
    ).toEqual({
      userArgs: '--model sonnet',
      choices: { options: { effort: 'high' } }
    })
    expect(
      reconcileAgentChoiceArgs({
        ...input,
        userArgs: '--model opus --effort high',
        mode: 'choice-edit',
        patch: { model: null }
      })
    ).toEqual({ userArgs: '', choices: { options: { effort: 'high' } } })
  })

  it('reconciles unpatched dirty choices and recomposes generated model options', () => {
    expect(
      reconcileAgentChoiceArgs({
        agent: 'claude',
        userArgs: '--model opus --effort low --verbose',
        choices: { model: 'sonnet', options: { effort: 'high' } },
        keys,
        mode: 'choice-edit',
        patch: { permissionMode: 'ask' }
      })
    ).toEqual({
      userArgs: '--verbose',
      choices: {
        model: 'opus',
        options: { effort: 'low' },
        permissionMode: 'ask'
      }
    })
    expect(
      reconcileAgentChoiceArgs({
        agent: 'claude',
        userArgs: '',
        choices: { model: 'opus', options: { effort: 'high' } },
        keys,
        mode: 'choice-edit',
        patch: { model: 'haiku' }
      }).choices
    ).toEqual({ model: 'haiku' })
    const choices = { model: 'claude-opus-4-8', options: { thinking: 'true', effort: 'high' } }
    const next = reconcileAgentChoiceArgs({
      agent: 'cursor',
      userArgs: '--model claude-opus-4-8-thinking-high --verbose',
      choices,
      keys: new Set(['model', 'thinking', 'effort']),
      mode: 'choice-edit',
      patch: { options: { effort: null } }
    })
    expect(next).toEqual({
      userArgs: '--verbose',
      choices: {
        model: choices.model,
        options: { thinking: 'true' }
      }
    })
    expect(
      projectAgentLaunchProfile(
        'cursor',
        { agentPermissionDefault: 'own' },
        {
          target: 'terminal',
          ...next
        }
      ).args
    ).toBe('--model claude-opus-4-8-thinking --verbose')
  })

  it('does not revive remembered model/options when raw text defeats a yielding layer', () => {
    const input = {
      agent: 'claude' as const,
      remembered: { model: 'sonnet', options: { effort: 'high' } },
      action: { model: 'opus', options: { effort: 'low' }, permissionMode: 'ask' as const },
      argumentOwner: 'launch' as const,
      launchPreferencesYieldToAgentArgs: true
    }
    expect(resolveAgentChoiceLayers({ ...input, userArgs: '--model haiku' })).toEqual({
      permissionMode: 'ask'
    })
    expect(resolveAgentChoiceLayers({ ...input, userArgs: '--effort medium' })).toEqual({
      model: 'opus',
      permissionMode: 'ask'
    })
    expect(
      resolveAgentChoiceLayers({ ...input, userArgs: '--model haiku', explicit: { model: 'opus' } })
    ).toEqual({ model: 'opus', permissionMode: 'ask' })
  })

  it('resolves raw inheritance before projecting and never imports another model’s options', () => {
    expect(
      resolveAgentChoiceLayers({
        agent: 'claude',
        defaults: { model: 'sonnet' },
        action: { model: 'opus' },
        userArgs: '--append-system-prompt hello',
        argumentOwner: 'launch',
        launchPreferencesYieldToAgentArgs: true
      })
    ).toEqual({ model: 'opus' })
    expect(
      resolveAgentChoiceLayers({
        agent: 'claude',
        remembered: { model: 'sonnet', options: { effort: 'high' } },
        explicit: { model: 'opus' },
        argumentOwner: 'defaults'
      })
    ).toEqual({ model: 'opus' })
    expect(
      resolveAgentChoiceLayers({
        agent: 'claude',
        remembered: { model: 'sonnet' },
        defaults: { options: { effort: 'high' } },
        argumentOwner: 'defaults'
      })
    ).toEqual({ model: 'sonnet', options: { effort: 'high' } })
    expect(
      projectAgentLaunchProfile(
        'claude',
        { agentPermissionDefault: 'ask' },
        { target: 'terminal', choices: { options: { effort: 'high' } }, userArgs: '' }
      ).args
    ).toContain('--effort')
    expect(
      projectAgentLaunchProfile(
        'claude',
        { agentPermissionDefault: 'ask' },
        { target: 'structured', choices: { model: 'opus' }, userArgs: '' }
      )
    ).toEqual({ args: '', choices: { model: 'opus', permissionMode: 'ask' } })
    expect(agentLaunchNeedsPreparedCommand('claude', { effort: 'high' })).toBe(true)
    expect(agentLaunchNeedsPreparedCommand('codex', { model: 'unlisted', effort: 'high' })).toBe(
      false
    )
  })
})
