import type * as NodeOs from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { resolveCodexLaunchHome } from '../codex/codex-launch-home'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

// Hook install and session bridges are launch chores outside the key; keep them off disk.
vi.mock('../codex/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: async () => ({ state: 'installed' }) }
}))
vi.mock('../codex/codex-hook-reconcile', () => ({ reconcileCodexHooksForLaunch: async () => {} }))
vi.mock('../codex/codex-session-bridge', () => ({
  startSystemCodexSessionBridgeInBackground: async () => {}
}))
vi.mock('../codex/codex-account-session-bridge', () => ({
  startCodexAccountSessionBridgeInBackground: async () => {}
}))

// Use production wiring so catalog reads and launches cannot silently drift apart.
async function wireCodexAccountKey(
  settings: ReturnType<typeof createSettings>,
  launchEnv: NodeJS.ProcessEnv = {}
) {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  const { mainProcessState } = await import('../startup/main-process-state')
  const { codexStructuredLaunchHomeResolvers } = await import('../startup/codex-launch-preparation')
  const { structuredAgentRuntimeRegistration } =
    await import('../runtime/structured-agent-runtime-registrations')
  const { agentModelCatalogFingerprint } =
    await import('../native-chat/agent-model-catalog/agent-model-catalog-fingerprint')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the settings read/update surface the service uses.
  const runtimeHome = new CodexRuntimeHomeService(createStore(settings) as never)
  mainProcessState.codexRuntimeHome = runtimeHome
  const codex = structuredAgentRuntimeRegistration('codex')!
  const services = {
    getClaudeConfigDirectory: () => null,
    prepareCodexLaunchHome: codexStructuredLaunchHomeResolvers.prepareCodexStructuredLaunch,
    readCodexLaunchHome: codexStructuredLaunchHomeResolvers.resolveCodexStructuredLaunchHome,
    workspaceTrustSettings: () => settings,
    stateDirectory: '/orca-data'
  }
  const resolve = (purpose: 'launch' | 'read') =>
    codex.resolveAccountHome({ launchEnv, location: null, purpose, workspacePath: null }, services)
  const key = (accountHome: AgentSessionAccountHome) =>
    agentModelCatalogFingerprint({ agent: 'codex', accountHome, wslDistro: null })
  return { resolve, key, release: () => (mainProcessState.codexRuntimeHome = null) }
}

describe('Codex catalog account key: picker read vs launch', () => {
  let release: (() => void) | null = null

  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    release?.()
    release = null
    teardownRuntimeHomeTest()
  })

  async function expectOneKey(settings: ReturnType<typeof createSettings>, expectedPath: string) {
    const wired = await wireCodexAccountKey(settings)
    release = wired.release
    const before = await wired.resolve('read')
    const launched = await wired.resolve('launch')
    const after = await wired.resolve('read')

    expect(launched).toMatchObject({ variable: 'CODEX_HOME', path: expectedPath })
    expect(wired.key(before)).toBe(wired.key(launched))
    expect(wired.key(after)).toBe(wired.key(launched))
  }

  it('system account on the real ~/.codex', async () => {
    await expectOneKey(createSettings({ realHomeRoutable: true }), getSystemCodexHomePath())
  })

  it('system account no longer routes through the legacy mirror', async () => {
    await expectOneKey(createSettings({ realHomeRoutable: false }), getSystemCodexHomePath())
  })

  it('pins read and actual launch inputs to system selection despite a custom CODEX_HOME', async () => {
    const custom = '/fixture/custom-codex-home'
    const wired = await wireCodexAccountKey(createSettings({ realHomeRoutable: true }), {
      CODEX_HOME: custom
    })
    release = wired.release
    const read = await wired.resolve('read')
    const launched = await wired.resolve('launch')
    expect(requireLegacyAgentSessionAccountHome(read).path).toBe(getSystemCodexHomePath())
    expect(launched).toEqual(read)
    const { createCodexModelCatalogProbe } = await import('../codex/codex-model-catalog-probe')
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ CODEX_HOME: custom }),
      resolveCommand: () => 'codex',
      runSession: async (invocation, body) => {
        expect(invocation.env?.CODEX_HOME).toBe(requireLegacyAgentSessionAccountHome(launched).path)
        return body({
          request: async () => ({
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                isDefault: true
              }
            ],
            nextCursor: null
          }),
          notify: () => {}
        })
      }
    })
    expect((await probe(read)).models.map((model) => model.id)).toEqual(['gpt-live'])
  })

  it('a managed account overlay over the shared conversation store', async () => {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    await expectOneKey(
      createSettings({
        realHomeRoutable: true,
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', managedHomePath)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      }),
      resolveCodexLaunchHome({ selectedAccount: { homePath: managedHomePath }, readOnly: true })!
    )
  })
})
