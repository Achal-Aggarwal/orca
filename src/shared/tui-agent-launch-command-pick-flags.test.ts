import { tokenizeStartupCommand } from './tui-agent-startup-shell'
import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

function launch(args: Partial<Parameters<typeof resolveAgentLaunchCommand>[0]>) {
  const result = resolveAgentLaunchCommand({
    agent: 'claude',
    cmdOverrides: {},
    platform: 'linux',
    shell: 'posix',
    ...args
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result
}

describe('one copy of each chat-picked flag', () => {
  it('sends one -m for Codex with a pick and a configured -m', () => {
    const result = launch({
      agent: 'codex',
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      agentArgs: '-m o3'
    })
    expect(result.command).toBe("codex '-m' 'o3'")
    expect(result.appliedSessionOptions).toEqual({})
  })

  it.each(['-c model=o3', '--config model=o3', '-c=model=o3', '-cmodel=o3', '--config=model=o3'])(
    'yields the picked Codex model and its effort to configured %s',
    (agentArgs) => {
      const result = launch({
        agent: 'codex',
        sessionOptions: { model: 'gpt-5.5', effort: 'high' },
        agentArgs
      })
      const expectedArgs = agentArgs
        .split(' ')
        .map((token) => `'${token}'`)
        .join(' ')
      expect(result.command).toBe(`codex ${expectedArgs}`)
      expect(result.appliedSessionOptions).toEqual({})
    }
  )

  it('treats spaced Codex config model and effort as raw pins or removes them when overridden', () => {
    const agentArgs = '-c " model = o3" -c " model_reasoning_effort = low" -c model_verbosity=low'
    const inputs = {
      agent: 'codex' as const,
      agentArgs,
      sessionOptions: { model: 'gpt-5.5', effort: 'high' }
    }
    expect(launch(inputs).appliedSessionOptions).toEqual({})
    const saved = launch({ ...inputs, sessionOptionsOverrideAgentArgs: true })
    expect(saved.appliedSessionOptions).toEqual(inputs.sessionOptions)
    expect(saved.resumeLaunch).toEqual({
      agentCommand: "codex '-c' 'model_verbosity=low'",
      agentArgs: "'-c' 'model_verbosity=low'"
    })
  })

  it('sends only the configured Grok model without the picked model effort', () => {
    const result = launch({
      agent: 'grok',
      sessionOptions: { model: 'grok-4.6', effort: 'xhigh' },
      agentArgs: '-m grok-4.5'
    })
    expect(result.command).toBe("grok '-m' 'grok-4.5'")
    expect(result.appliedSessionOptions).toEqual({})
  })

  it.each([
    ['claude', 'opus', '--model=haiku', "claude '--model=haiku'"],
    ['codex', 'gpt-5.5', '-mo3', "codex '-mo3'"]
  ] as const)(
    'sends one model flag for %s with a configured %s',
    (agent, model, agentArgs, command) => {
      const result = launch({ agent, sessionOptions: { model }, agentArgs })
      expect(result.command).toBe(command)
      expect(result.appliedSessionOptions).toEqual({})
    }
  )

  it('sends one --effort for Claude with a configured --effort', () => {
    const result = launch({
      sessionOptions: { model: 'opus', effort: 'xhigh' },
      agentArgs: '--effort low'
    })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'low'")
    expect(result.appliedSessionOptions).toEqual({ model: 'opus' })
  })

  it('keeps the catalog default for options the configured args do not set', () => {
    const result = launch({ sessionOptions: { model: 'opus' }, agentArgs: '--add-dir x' })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'high' '--add-dir' 'x'")
  })

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'preserves picks when a Docker override has a memory flag on %s',
    (shell) => {
      const result = launch({
        agent: 'codex',
        shell,
        platform: shell === 'posix' ? 'linux' : 'win32',
        cmdOverrides: { codex: 'docker run --rm -m 4g agent-image codex' },
        sessionOptions: { model: 'gpt-5.5', effort: 'high' }
      })
      expect(result.appliedSessionOptions).toEqual({ model: 'gpt-5.5', effort: 'high' })
      expect(result.command).toContain('gpt-5.5')
      expect(result.command).toContain('model_reasoning_effort=high')
    }
  )

  it.each(['echo --model diagnostic && claude', "claude --append-system-prompt '--model'"])(
    'preserves picks when override tokens are not agent options: %s',
    (command) => {
      const result = launch({
        cmdOverrides: { claude: command },
        sessionOptions: { model: 'opus', effort: 'high' }
      })
      expect(result.command).toBe(`${command} '--model' 'opus' '--effort' 'high'`)
      expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'high' })
    }
  )

  it('preserves picks when configured arguments contain flags after --', () => {
    const result = launch({
      agentArgs: '-- --model haiku',
      sessionOptions: { model: 'opus', effort: 'high' }
    })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'high' '--' '--model' 'haiku'")
    expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'high' })
  })

  it('checks configured args without parsing an unparseable command override', () => {
    const result = launch({
      agent: 'codex',
      cmdOverrides: { codex: "codex -c 'x" },
      sessionOptions: { model: 'gpt-5.5' },
      agentArgs: '-m o3'
    })
    expect(result.command).toBe("codex -c 'x '-m' 'o3'")
    expect(result.command).not.toContain('gpt-5.5')
  })

  it('sends the picked Codex model when the configured args set only the effort', () => {
    const result = launch({
      agent: 'codex',
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      agentArgs: '-c model_reasoning_effort=low'
    })
    expect(result.command).toBe("codex '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=low'")
    expect(result.appliedSessionOptions).toEqual({ model: 'gpt-5.5' })
  })
})

describe('a saved permission mode on terminals', () => {
  it.each([
    ['claude', 'ask', '--permission-mode auto --verbose', "'--permission-mode' 'auto' '--verbose'"],
    // A required operand and an argument after -- do not own permission.
    [
      'claude',
      'ask',
      "--append-system-prompt '--dangerously-skip-permissions'",
      "'--append-system-prompt' '--dangerously-skip-permissions' '--permission-mode' 'default'"
    ],
    [
      'claude',
      'ask',
      '-- --dangerously-skip-permissions',
      "'--permission-mode' 'default' '--' '--dangerously-skip-permissions'"
    ],
    ['codex', 'ask', '', "'-a' 'on-request' '-s' 'read-only' '-c' 'approvals_reviewer=user'"],
    ['codex', 'ask', '--yolo', "'--yolo'"],
    ['gemini', 'full-access', '--approval-mode default', "'--approval-mode' 'default'"],
    ['opencode', 'full-access', '--print-logs', "'--print-logs'"]
  ] as const)(
    '%s %s follows shared permission ownership for %s',
    (agent, permissionMode, agentArgs, expectedArgs) => {
      const plain = launch({ agent, agentArgs: '' }).command
      const result = launch({
        agent,
        agentArgs,
        sessionOptions: { permissionMode },
        sessionOptionsOverrideAgentArgs: true
      })
      expect(result.command).toBe(expectedArgs ? `${plain} ${expectedArgs}` : plain)
    }
  )

  it('yields to a permission flag the caller keeps', () => {
    const result = launch({
      agent: 'claude',
      agentArgs: '--dangerously-skip-permissions',
      sessionOptions: { permissionMode: 'ask' }
    })
    expect(result.command).toBe("claude '--dangerously-skip-permissions'")
    expect(result.appliedSessionOptions).toEqual({})
  })
})

it.each([false, true])(
  'keeps Claude effective settings and Restart literal with override=%s',
  (override) => {
    const raw = `--settings '{"language":"french"}' --settings '{"env":{"SAFE":"kept"}}' --add-dir docs`
    const result = launch({
      agentArgs: raw,
      sessionOptions: { fastMode: true },
      sessionOptionsOverrideAgentArgs: override
    })
    const parsed = tokenizeStartupCommand(result.command, 'posix')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error('invalid compiler result')
    }
    const settings = parsed.tokens
      .filter((_, index) => parsed.tokens[index - 1] === '--settings')
      .map((value) => JSON.parse(value))
    expect(settings).toEqual([
      { language: 'french' },
      { env: { SAFE: 'kept' }, ...(override ? { fastMode: true } : {}) }
    ])
    expect(result.appliedSessionOptions.fastMode).toBe(override ? true : undefined)
    const restart = tokenizeStartupCommand(result.resumeLaunch.agentCommand, 'posix')
    expect(restart.ok).toBe(true)
    if (!restart.ok) {
      throw new Error('invalid Restart')
    }
    const resumed = restart.tokens
      .filter((_, index) => restart.tokens[index - 1] === '--settings')
      .map((value) => JSON.parse(value))
    expect(resumed).toEqual(settings)
  }
)

it('never claims Fast applied over a literal settings file, including custom commands', () => {
  for (const override of [false, true]) {
    const result = launch({
      cmdOverrides: { claude: 'my-claude' },
      agentArgs: '--settings ./team.json',
      sessionOptions: { fastMode: true },
      sessionOptionsOverrideAgentArgs: override
    })
    expect(result.command).toBe("my-claude '--settings' './team.json'")
    expect(result.appliedSessionOptions.fastMode).toBeUndefined()
    expect(result.resumeLaunch.agentCommand).toBe(result.command)
  }
})

it('retains same-token-count Claude settings rewrites in projection and Restart', () => {
  const agentArgs = `--settings '{"language":"french","fastMode":true}'`
  const result = launch({
    agentArgs,
    sessionOptions: { fastMode: false },
    sessionOptionsOverrideAgentArgs: true
  })
  expect(result.command).toContain('"language":"french","fastMode":false')
  expect(result.resumeLaunch.agentArgs).toContain('"language":"french","fastMode":false')
  expect(result.appliedSessionOptions.fastMode).toBe(false)
  const conflict = resolveAgentLaunchCommand({
    agent: 'claude',
    platform: 'linux',
    shell: 'posix',
    cmdOverrides: { claude: 'my-claude --settings ./fixed.json' },
    agentArgs,
    sessionOptions: { fastMode: false },
    sessionOptionsOverrideAgentArgs: true
  })
  expect(conflict).toMatchObject({ ok: false, error: expect.stringContaining('conflicts') })
})
