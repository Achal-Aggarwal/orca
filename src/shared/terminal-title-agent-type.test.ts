import { describe, expect, it } from 'vitest'
import { getAgentLabel as getSharedAgentLabel } from './agent-title-identity'
import { resolveTabAgentFromSignals } from './tab-agent-from-signals'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import {
  isClaudeIdentityFrameTitle,
  isGrokRotatingWorkingTitle,
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'

describe('isGrokRotatingWorkingTitle', () => {
  it('matches Grok working frames regardless of the rotating middle text', () => {
    expect(isGrokRotatingWorkingTitle('⠋ - Waiting for response… - grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠴ - Thinking - grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠦ - Sleep 2s then echo hello… - grok')).toBe(true)
    // Collapsed/stable form must stay matched so re-normalization is idempotent.
    expect(isGrokRotatingWorkingTitle('⠋ grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠋ Grok')).toBe(true)
  })

  it('ignores non-working, non-Grok, and lookalike titles', () => {
    expect(isGrokRotatingWorkingTitle('grok')).toBe(false) // idle bare name, no spinner
    expect(isGrokRotatingWorkingTitle('Fix the auth bug - grok')).toBe(false) // session title, no spinner
    expect(isGrokRotatingWorkingTitle('⠋ debugging grok - claude')).toBe(false) // trailing name is another agent
    expect(isGrokRotatingWorkingTitle('⠋ ~/grok-scratch/ready')).toBe(false) // path fragment, not a trailing token
    expect(isGrokRotatingWorkingTitle('⠋ grokking the plan')).toBe(false) // "grok" not a whole trailing token
    expect(isGrokRotatingWorkingTitle('⠋ Codex')).toBe(false)
    // Task text ending in "grok" is not the Grok frame shape "spinner - phrase - grok".
    expect(isGrokRotatingWorkingTitle('⠋ wire up grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ Codex is thinking about grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ support for Grok')).toBe(false)
    // Require Grok’s post-spinner delimiter so Claude/Codex task text ending in - grok keeps its identity.
    expect(isGrokRotatingWorkingTitle('⠋ fix the flaky suite - grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ review grok integration - claude')).toBe(false)
  })
})

describe('resolveExplicitTerminalTitleAgentType', () => {
  it('treats Claude generic status prefixes as activity-only, not identity', () => {
    expect(resolveExplicitTerminalTitleAgentType('✳ investigating startup')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('⠸ investigating startup')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('. Compare Opencode Vs Orca')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('* Review Codex behavior')).toBeNull()
  })

  it('resolves OpenCode native abbreviated session titles before task-text identities', () => {
    expect(resolveExplicitTerminalTitleAgentType('OC | Understand about the plugin')).toBe(
      'opencode'
    )
    expect(resolveExplicitTerminalTitleAgentType('OC | Compare Codex and Claude')).toBe('opencode')
    // Why: Gemini glyphs inside OpenCode session text must not rebrand the tab.
    expect(resolveExplicitTerminalTitleAgentType('OC | ✦ Gemini CLI')).toBe('opencode')
    expect(getSharedAgentLabel('OC | Compare Codex and Claude')).toBe('OpenCode')
    expect(getSharedAgentLabel('OC | ✦ Gemini CLI')).toBe('OpenCode')
    expect(resolveExplicitTerminalTitleAgentType('tmux | OC | ses_123')).toBe('opencode')
    expect(resolveExplicitTerminalTitleAgentType('OC|compact-session')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('oc | Understand about the plugin')).toBeNull()
  })

  it('does not find an OpenCode marker inside another agent task title', () => {
    expect(isOpenCodeNativeTitle('⠋ Fix foo | OC | bar')).toBe(false)
    expect(resolveExplicitTerminalTitleAgentType('⠋ Fix foo | OC | bar')).toBeNull()
  })

  // Only explicit Claude identity may replace the owner; task-text mentions do not prove identity (#8940).
  it('separates Claude identity frames from an incidental claude token', () => {
    for (const title of [
      'Claude Code',
      '✳ Claude Code',
      '⠋ Claude Code',
      'claude',
      '. claude',
      'Claude Code ready',
      'Claude - action required',
      // A multiplexer prefix must not read as task text and cost Claude its identity.
      'zsh | ⠋ Claude Code',
      'tmux | dev | Claude Code ready'
    ]) {
      expect(isClaudeIdentityFrameTitle(title)).toBe(true)
    }
    for (const title of [
      '⠋ use Claude Sonnet',
      'OC | ⠋ ask claude about this',
      '⠋ port the claude prompt',
      '. ship it with claude',
      '⠋ claude 스타일로 리팩터',
      '. Claude Code compare Opencode',
      '✳ investigating startup',
      '✳'
    ]) {
      expect(isClaudeIdentityFrameTitle(title)).toBe(false)
    }
  })

  // cursor is ordinary task vocabulary; only Cursor’s identity frames can claim the pane.
  it('resolves Cursor by its identity titles, never a bare cursor token', () => {
    expect(resolveExplicitTerminalTitleAgentType('Cursor Agent')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('⠋ Cursor Agent')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('Cursor ready')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('Cursor - action required')).toBe('cursor')
    // A Claude tab whose task text mentions a text cursor is not Cursor identity.
    expect(
      resolveExplicitTerminalTitleAgentType('⠋ preserve cursor visibility across replays')
    ).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('~/cursor-rules')).toBeNull()
  })
})

describe('resolveTerminalTitleAgentType', () => {
  // Keep Claude activity for cursor mentions while recognizing real Cursor identity titles.
  it('labels cursor-mentioning agent tabs by their true agent, real Cursor as cursor', () => {
    expect(resolveTerminalTitleAgentType('⠋ Cursor Agent')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('Cursor Agent')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('Cursor ready')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('Cursor - action required')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('⠋ preserve cursor visibility across replays')).toBe(
      'claude'
    )
    expect(resolveTerminalTitleAgentType('⠋ Codex: fix cursor offsets')).toBe('codex')
  })
})

describe('explicit identity admission shared by display and input readers', () => {
  it.each([
    'codex',
    'grok',
    'gemini',
    'copilot',
    'devin',
    'aider',
    'openclaude',
    'claude',
    'jcode',
    'antigravity',
    'droid',
    'hermes',
    'mimo'
  ])('does not identify a task mentioning %s', (name) => {
    expect(resolveExplicitTerminalTitleAgentType(`⠋ fix the ${name} launcher`)).toBeNull()
  })

  // Native/synthetic spellings already recognized by the title parser and its producer fixtures.
  it.each([
    ['Claude Code', 'claude'],
    ['claude.bat working', 'claude'],
    ['⠋ OpenClaude', 'openclaude'],
    ['openclaude.cmd', 'openclaude'],
    ['⠋ Codex: fix cursor offsets', 'codex'],
    ['codex.exe', 'codex'],
    ['✦ Analyzing the repository', 'gemini'],
    ['◇ Gemini CLI', 'gemini'],
    ['GitHub Copilot', 'copilot'],
    ['copilot.exe - action required', 'copilot'],
    ['devin thinking', 'devin'],
    ['aider.ps1 ready', 'aider'],
    ['⠋ - Waiting for response… - grok', 'grok'],
    ['grok done', 'grok'],
    ['Jcode', 'jcode'],
    ['Antigravity', 'antigravity'],
    ['agy — Gemini 3.1 Pro', 'antigravity'],
    ['OC | Compare Codex and Claude', 'opencode'],
    ['ssh host | opencode ready', 'opencode'],
    ['opencode2', 'opencode2'],
    ['MiMo Code', 'mimo-code'],
    ['Cursor Agent', 'cursor'],
    ['⠋ Droid', 'droid'],
    ['hermes ready', 'hermes'],
    ['DeepSeek Build', 'dsb'],
    ['🐋 DeepSeek Harness', 'dsh'],
    ['π > session - ~/orca', 'pi'],
    ['OMP ready', 'omp'],
    ['Qoder CLI', 'qoder'],
    ['Qoder CLI CN', 'qoder-cn'],
    ['Compare Antigravity with Gemini… - grok', 'grok']
  ])('preserves the identity frame %j', (title, agent) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe(agent)
    expect(
      resolveTabAgentFromSignals({
        title,
        hookAgent: null,
        hasObservedAgentSignal: true,
        isRemote: true,
        launchAgent: agent === 'claude' ? 'codex' : 'claude'
      })
    ).toBe(agent)
  })

  it.each([
    'claude | zsh',
    'codex | main | fix the parser',
    '⠋ grok > next steps',
    'OC | session - grok'
  ])('rejects wrapper prefixes, breadcrumbs and competing identities in %j', (title) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).toBeNull()
  })
})
