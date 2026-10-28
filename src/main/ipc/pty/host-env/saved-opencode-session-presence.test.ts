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
  capture.mockImplementation(async ({ env }) => ({ status: 'captured', env }))
})
afterEach(() => vi.clearAllMocks())
it.each(['present', 'absent', 'unavailable'])(
  '%s changes only a confirmed-missing automatic launch',
  async (value) => {
    presence.mockResolvedValue(value)
    const request = args(),
      options = { ...request }
    const result = await chooseSavedResumeFreshLaunch(runtime, request, null, options)
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
it('uses the assembled native-owner environment without selecting an account again', async () => {
  const request = args()
  request.env = { ...request.env, HOME: '/owner', XDG_DATA_HOME: '/owner/data' }
  const options = { ...request }
  await chooseSavedResumeFreshLaunch(runtime, request, null, options, true)
  expect(project).not.toHaveBeenCalled()
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({ HOME: '/owner', XDG_DATA_HOME: '/owner/data' })
    })
  )
})
it('keeps today’s attempt when shell capture or worker fails', async () => {
  capture.mockResolvedValue({ status: 'fallback', env: {} })
  const request = args(),
    options = { ...request }
  await chooseSavedResumeFreshLaunch(runtime, request, null, options)
  expect(options.command).toBe(request.command)
  expect(presence).not.toHaveBeenCalled()
})
