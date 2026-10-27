import { describe, expect, it } from 'vitest'
import { findOptionOccurrence } from './command-option-occurrence'
import { planCommitMessageGeneration } from './commit-message-plan'

describe('Kimi effective output format', () => {
  it.each([
    ['', '', 'stream-json'],
    ['', '--output-format=text', 'text'],
    ['', '--output-format text --output-format stream-json', 'text'],
    ['--output-format text', '', 'text'],
    ['--output-format text', '--output-format=stream-json', 'stream-json'],
    ['--output-format=text --output-format stream-json', '', 'text'],
    ['', '--output-format text -- --output-format stream-json', 'text'],
    ['-- --output-format stream-json', '', undefined],
    ['--output-format text -- --output-format stream-json', '', 'text'],
    ['--model "--" --output-format text', '--output-format stream-json', 'stream-json'],
    ['', '--model "--output-format=text"', 'stream-json'],
    ['', '-m "--output-format=text" --output-format text', 'text'],
    ['', '--agent "--output-format=text"', 'stream-json'],
    ['', '-p "--output-format=text"', 'stream-json']
  ])('keeps prefix %s and recipe %s consistent', (prefix, agentArgs, format) => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'kimi',
        model: 'default',
        agentArgs,
        agentCommandOverride: `kimi ${prefix}`
      },
      '--output-format=text'
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.outputFormat).toBe(format === 'stream-json' ? 'kimi-stream-json' : undefined)
    if (format) {
      const active = findOptionOccurrence(
        result.plan.args,
        ['--output-format'],
        true,
        ['--prompt', '-p', '--model', '-m', '--agent'],
        0,
        'required'
      )
      expect(active?.value).toBe(format)
    }
  })

  it.each(['--', '--output-format=text', '--model'])('preserves prompt operand %s', (prompt) => {
    const result = planCommitMessageGeneration(
      { agentId: 'kimi', model: 'default', agentArgs: '--output-format=text' },
      prompt
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.args).toEqual(['--prompt', prompt, '--output-format=text'])
    expect(result.plan.outputFormat).toBeUndefined()
  })

  it('leaves one effective singleton with recipe > prefix > generated precedence', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'kimi',
        model: 'kimi-code/kimi-for-coding',
        agentCommandOverride: 'kimi --output-format text --model prefix-model',
        agentArgs: '--output-format=stream-json --output-format text -m recipe-model'
      },
      'PROMPT'
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.args).toEqual([
      '--prompt',
      'PROMPT',
      '--output-format=stream-json',
      '-m',
      'recipe-model'
    ])
    expect(result.plan.outputFormat).toBe('kimi-stream-json')
  })

  it('does not assign a protocol to a custom command named kimi', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'kimi -p {prompt} --output-format stream-json'
      },
      'PROMPT'
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.args).toEqual(['-p', 'PROMPT', '--output-format', 'stream-json'])
    expect(result.plan.outputFormat).toBeUndefined()
  })
})

it('keeps Kimi recipe args out of required format/model operands matching the prompt', () => {
  for (const prompt of ['stream-json', 'kimi-code/kimi-for-coding']) {
    const result = planCommitMessageGeneration(
      { agentId: 'kimi', model: 'kimi-code/kimi-for-coding', agentArgs: '--agent reviewer' },
      prompt
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.args).toEqual([
      '--prompt',
      prompt,
      '--output-format',
      'stream-json',
      '--model',
      'kimi-code/kimi-for-coding',
      '--agent',
      'reviewer'
    ])
    expect(result.plan.outputFormat).toBe('kimi-stream-json')
  }
})
