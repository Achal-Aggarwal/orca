import { expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildQuickComposerStartup, type QuickComposerStartupInput } from './quick-startup-plan'
import { tokenizeStartupCommand } from '../../../../shared/tui-agent-startup-shell'

const input: QuickComposerStartupInput = {
  agent: 'codex',
  prompt: '',
  draftPrompt: null,
  settings: {
    ...getDefaultSettings('/test'),
    agentDefaultArgs: { codex: '--model old-model -c model_reasoning_effort=high' }
  },
  launchHost: { kind: 'known', platform: 'linux', hostKind: 'local' },
  shell: 'posix',
  isRemote: false,
  telemetrySource: 'sidebar'
}
it('compiles explicit workspace setup once and keeps ordinary terminal defaults', () => {
  const ordinary = buildQuickComposerStartup(input).startupPlan?.launchCommand ?? ''
  expect(ordinary).toContain('old-model')
  const configured =
    buildQuickComposerStartup({
      ...input,
      launchSetup: {
        agent: 'codex',
        surface: 'terminal',
        choices: { model: 'private-alias', options: { effort: 'low' } }
      }
    }).startupPlan?.launchCommand ?? ''
  const parsed = tokenizeStartupCommand(configured, 'posix')
  expect(parsed.ok && parsed.tokens.filter((token) => token === 'private-alias')).toHaveLength(1)
  expect(configured).not.toContain('old-model')
  expect(configured).toContain('model_reasoning_effort=low')
  expect(configured).not.toContain('model_reasoning_effort=high')
})
it('preserves explicit empty Arguments and the blank-terminal route', () => {
  const empty =
    buildQuickComposerStartup({
      ...input,
      launchSetup: { agent: 'codex', surface: 'terminal', choices: {}, arguments: null }
    }).startupPlan?.launchCommand ?? ''
  expect(empty).not.toContain('old-model')
  expect(buildQuickComposerStartup({ ...input, agent: null }).startupPlan).toBeNull()
})
