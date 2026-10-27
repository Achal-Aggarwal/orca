import { expect, it, vi } from 'vitest'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { agentModelCatalogEntry } from '../../../native-chat/agent-model-catalog/agent-model-catalog-entry'
import {
  createPiModelCatalogProbe,
  piModelCatalogFromListing
} from '../../../pi/rpc-model-catalog-probe'
import { assertAgentSessionOptionsAdmitted } from '../../agent-session-record-options'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { prepareStructuredAgentSessionCreateForWorktree } from './structured-agent-session-create'

const listing = (models: unknown[]) => ({ origin: 'probe', models })

async function prepareWithSeed(
  seed: Readonly<Record<string, string>> | undefined,
  options: Readonly<Record<string, string>> | undefined,
  listingModels: unknown[] | null
): Promise<AgentSessionAttachParams['options']> {
  const attachParams = {
    envelope: {
      sessionId: 'pi_session_1',
      clientOperationId: 'operation-1',
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'pi',
    agent: 'pi',
    accountHome: { variable: 'HOME', path: '/home/user' },
    runtimeKind: 'native' as const,
    ...(seed ? { options: seed } : {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the members prepare reaches.
  const host = {
    deps: {
      modelCatalog: listingModels ? { read: vi.fn(async () => listing(listingModels)) } : undefined
    }
  } as unknown as StructuredAgentSessionHost
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the members prepare reaches.
  const runtime = {
    resolveStructuredAgentSessionCreateIntent: vi.fn(async () => attachParams),
    resolveStructuredAgentSessionLocalWorkspacePath: vi.fn(async () => '/work/repo')
  } as unknown as OrcaRuntimeService
  const prepared = await prepareStructuredAgentSessionCreateForWorktree({
    runtime,
    ensureHost: async () => host,
    envelope: attachParams.envelope,
    worktree: 'id:workspace-1',
    agent: 'pi',
    caller: { callerKey: 'caller-1' },
    ...(options ? { options } : {})
  })
  return prepared.attachParams.options
}

const piRow = (efforts: readonly string[]) => ({
  id: 'some/model',
  label: 'Some Model',
  isDefault: false,
  efforts: efforts.map((value) => ({ value, label: value }))
})

it('moves a remembered effort the saved probe row lacks to its nearest listed level', async () => {
  // Pi's live menu offers xhigh where its --list-models probe stops at high.
  const options = await prepareWithSeed({ model: 'some/model', effort: 'xhigh' }, undefined, [
    piRow(['off', 'minimal', 'low', 'medium', 'high'])
  ])
  expect(options).toEqual({ model: 'some/model', effort: 'high' })
})

it('preserves remembered off intent through precise Pi discovery and create without relaxing explicit picks', async () => {
  const remembered = { model: 'openai/gpt-6', effort: 'off' }
  const previous = piModelCatalogFromListing(
    'provider model context max-out thinking images\nopenai gpt-6 400K 128K yes yes'
  )
  expect(await prepareWithSeed(remembered, undefined, previous)).toEqual(remembered)
  const discovered = await createPiModelCatalogProbe({
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    resolveCommand: () => '/opt/pi/bin/pi',
    probeVersion: async () => ({ version: '1.1.0' }),
    homePath: '/home/user',
    connect: () => ({
      request: async () => ({
        models: [
          {
            provider: 'openai',
            id: 'gpt-6',
            name: 'GPT-6',
            reasoning: true,
            thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' }
          }
        ]
      }),
      close: async () => undefined
    })
  })({ variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi' })
  const entry = agentModelCatalogEntry('pi', 'account', { ...discovered, at: 2 }, null, {
    modelId: remembered.model,
    effort: 'high',
    at: 1
  })
  if (!entry) {
    throw new Error('successful discovery must produce a catalog entry')
  }
  const options = await prepareWithSeed(remembered, undefined, entry.models)
  expect(options).toEqual({ ...remembered, effort: 'minimal' })
  expect(() => assertAgentSessionOptionsAdmitted('pi', entry.models, options)).not.toThrow()
  const explicit = await prepareWithSeed(undefined, remembered, entry.models)
  expect(explicit).toEqual(remembered)
  expect(() => assertAgentSessionOptionsAdmitted('pi', entry.models, explicit)).toThrow(
    'agent_session_operation_invalid'
  )
})

it('drops a remembered effort its saved row no longer admits', async () => {
  const options = await prepareWithSeed({ model: 'some/model', effort: 'off' }, undefined, [
    piRow([])
  ])
  expect(options).toEqual({ model: 'some/model' })
})

it('keeps an effort this launch named itself, even one its row does not admit', async () => {
  // Explicit options replace the saved selection; only their own values stay the caller's picks.
  const options = await prepareWithSeed({ model: 'some/model' }, { effort: 'off' }, [piRow([])])
  expect(options).toEqual({ effort: 'off' })
})

it('keeps a remembered effort when no saved rows name its model', async () => {
  const options = await prepareWithSeed({ model: 'some/model', effort: 'off' }, undefined, [
    { id: 'other/model', label: 'Other Model', isDefault: false, efforts: [] }
  ])
  expect(options).toEqual({ model: 'some/model', effort: 'off' })
})
