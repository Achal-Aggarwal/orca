import { chooseSavedResumeFreshLaunch } from './saved-resume-fresh-launch'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildAgentResumeStartupPlan } from '../../../../shared/tui-agent-resume-startup'
import { createSequencedSetupAgentCommands } from '../../../../shared/setup-agent-sequencing'
import {
  forgetRefusedResume,
  savedResumeResult,
  type ResumeSpawnArgs
} from './saved-resume-admission'

const presence = vi.hoisted(() => vi.fn())
const capture = vi.hoisted(() => vi.fn())
const project = vi.hoisted(() => vi.fn())
const forget = vi.hoisted(() => vi.fn())
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { forgetRefusedPaneResume: forget }
}))
vi.mock('../../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', () => ({
  getSharedClient: () => ({ readSessionPresence: presence })
}))
vi.mock('../../../startup/login-shell-environment', () => ({
  captureLoginShellEnvironment: capture
}))
vi.mock('../../../managed-data-accounts/launch-environment', () => ({
  projectManagedDataAccountEnvironment: project
}))
vi.mock('../../../opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: async () => ({ version: '1.17.0', pluginApi: 'v1' })
}))
vi.mock('../../../opencode/opencode-session-source', () => ({
  resolveOpenCodeSessionSource: async () => ({
    root: '/owner/opencode',
    dbPath: '/owner/opencode/custom.db',
    api: 'v1'
  })
}))
const runtime = {
  openAgentSessionRecordStore: async () => ({
    listConversations: () => [],
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] })
  })
}
function args(): ResumeSpawnArgs {
  const session = { key: 'session_id' as const, id: 'ses_saved' }
  const startup = buildAgentResumeStartupPlan({
    agent: 'opencode',
    providerSession: session,
    cmdOverrides: {},
    platform: process.platform
  })!
  return {
    command: startup.launchCommand,
    cwd: process.cwd(),
    launchConfig: startup.launchConfig,
    resumeProviderSession: session,
    resumeOrigin: 'saved',
    launchAgent: 'opencode',
    launchToken: 'this-pane',
    env: { WORKSPACE: 'keep' }
  }
}
beforeEach(() => {
  presence.mockResolvedValue('absent')
  project.mockImplementation((env) => env)
  capture.mockImplementation(async ({ env, cwd }) => ({
    status: 'captured',
    env,
    executablePath: process.execPath,
    cwd
  }))
})
afterEach(() => vi.clearAllMocks())
it.each([
  ['present', false],
  ['absent', false],
  ['unavailable', false],
  ['absent', true]
] as const)(
  '%s changes only a confirmed-missing automatic launch (assembled %s)',
  async (value, assembled) => {
    presence.mockResolvedValue(value)
    const request = args(),
      options = { ...request }
    const result = await chooseSavedResumeFreshLaunch(runtime, request, null, options, assembled)
    expect(options.command).toBe(value === 'absent' ? 'opencode' : args().command)
    expect(request.resumeProviderSession?.id).toBe(value === 'absent' ? undefined : 'ses_saved')
    expect(request.launchAgent).toBe('opencode')
    expect(request.launchToken).toBe('this-pane')
    expect(request.launchConfig).toEqual(args().launchConfig)
    if (result?.verdict === 'unverifiable') {
      forgetRefusedResume('tab:leaf', result)
      expect(savedResumeResult(result)).toMatchObject({
        agentResumeUnavailable: true,
        agentResumeRefused: 'unverifiable',
        refusedResume: { providerSession: { id: 'ses_saved' } }
      })
    }
    if (assembled) {
      expect(project).not.toHaveBeenCalled()
    }
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: options.cwd,
        startedAfter: expect.any(Number),
        resolveCommand: 'opencode'
      })
    )
    expect(forget).not.toHaveBeenCalled()
  }
)
it('keeps the setup gate and removes the selector from both sequence payload and fallback', async () => {
  const request = args()
  const sequence = createSequencedSetupAgentCommands({
    runnerScriptPath: '/tmp/sta-11913-setup.sh',
    startupCommand: request.command!,
    platform: 'posix',
    nonce: 'test'
  })
  request.env = { ...request.env, ...sequence.startupEnv }
  request.command = sequence.startupCommand
  const options = { ...request }
  await chooseSavedResumeFreshLaunch(runtime, request, null, options)
  expect(options.command).toBe(sequence.startupCommand)
  expect(options.env?.ORCA_SEQUENCED_STARTUP_COMMAND).toBe('opencode')
  expect(options.env?.ORCA_SEQUENCED_STARTUP_SCRIPT).toContain('Waiting for setup')
  expect(options.env?.ORCA_SEQUENCED_STARTUP_SCRIPT).not.toContain('ses_saved')
})
it.each(['explicit', 'ssh-client', 'wsl', 'typed'] as const)(
  'leaves %s outside automatic inspection',
  async (kind) => {
    const request = args()
    if (kind === 'explicit') {
      delete request.resumeOrigin
    }
    if (kind === 'ssh-client') {
      request.connectionId = 'remote'
    }
    if (kind === 'typed') {
      request.command = 'opencode --session typed'
    }
    const options = { ...request }
    await chooseSavedResumeFreshLaunch(runtime, request, kind === 'wsl' ? 'Ubuntu' : null, options)
    expect(options.command).toBe(request.command)
    expect(presence).not.toHaveBeenCalled()
  }
)
it.each(['fallback', 'unresolved', 'worker'] as const)(
  'keeps today’s attempt when %s is unknown',
  async (kind) => {
    if (kind === 'fallback') {
      capture.mockResolvedValue({ status: 'fallback', env: {} })
    }
    if (kind === 'unresolved') {
      capture.mockResolvedValue({
        status: 'captured',
        env: {},
        cwd: process.cwd(),
        executablePath: null
      })
    }
    if (kind === 'worker') {
      presence.mockRejectedValue(new Error('worker unavailable'))
    }
    const request = args(),
      options = { ...request }
    await chooseSavedResumeFreshLaunch(runtime, request, null, options)
    expect(options.command).toBe(request.command)
    if (kind !== 'worker') {
      expect(presence).not.toHaveBeenCalled()
    }
  }
)
