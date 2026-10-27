import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { AGENT_LAUNCH_PICKER_METHODS } from './agent-launch-picker-inventory'

const mocks = vi.hoisted(() => ({
  detect: vi.fn(async () => ['codex']),
  read: vi.fn(async () => ({ origin: 'unknown' })),
  persist: vi.fn()
}))
vi.mock('../../../preflight/workspace-agent-detection', () => ({
  detectAgentsOnHost: mocks.detect
}))
vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/test-picker'
}))
vi.mock('../../structured-agent-model-catalog-wiring', () => ({
  attachAgentModelCatalogPersistenceOnce: mocks.persist
}))
vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ deps: { modelCatalog: { read: mocks.read } } })
}))
vi.mock('./structured-agent-session-policy', () => ({
  clientReadsStructuredSessionAgent: (_ctx: unknown, agent: string) => agent === 'codex'
}))

beforeEach(() => vi.clearAllMocks())

it('initial inventory reads saved catalogs; selected hydration joins only that agent owner without repeating discovery', async () => {
  const release = vi.fn()
  const support = vi.fn(async () => ({ supported: true }))
  const runtime = {
    requireStore: () => ({ getSettings: () => ({ experimentalNativeChat: true }) }),
    resolveAgentDetectionHost: async () => ({ kind: 'local' }),
    subscribeStructuredAgentAvailability: (receive: (rows: unknown[]) => void) => {
      receive([{ agent: 'codex', state: 'ready', chatProgram: 'available' }])
      return release
    },
    getStructuredAgentSessionCreateSupport: support,
    resolveStructuredAgentSessionLocalWorkspacePath: async () => '/workspace'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read-only handler uses exactly the runtime methods supplied by this fixture.
  const context = { runtime } as unknown as RpcContext
  const method = AGENT_LAUNCH_PICKER_METHODS[0]
  const initial = await method.handler({ worktree: 'id:workspace' }, context)
  expect(initial.entries.map((entry) => entry.agent)).toEqual(['codex'])
  expect(initial.entries[0]?.defaultSurface).toBe('chat')
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith({
    agent: 'codex',
    workspacePath: '/workspace',
    savedOnly: true
  })
  expect(mocks.detect).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
  expect(mocks.persist).not.toHaveBeenCalled()
  await method.handler({ worktree: 'id:workspace', agent: 'codex' }, context)
  expect(mocks.read).toHaveBeenLastCalledWith({
    agent: 'codex',
    workspacePath: '/workspace',
    waitForListing: true
  })
  expect(mocks.detect).toHaveBeenCalledTimes(1)
  expect(support).toHaveBeenCalledTimes(1)
})
