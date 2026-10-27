import { expect, it } from 'vitest'
import { readAgentPickerSavedCatalog } from './agent-launch-picker-saved-catalog'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'

it('reads only the selected account base and clears configured-default claims', async () => {
  const store = new AgentModelCatalogStore()
  const home = { variable: 'CLAUDE_CONFIG_DIR', path: '/selected' }
  const listing = {
    origin: 'probe' as const,
    complete: true,
    models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [] }]
  }
  for (const identity of [
    { accountHome: { ...home, path: '/another' } },
    { accountHome: home, folder: '/another-workspace' }
  ]) {
    store.recordSuccess(
      agentModelCatalogFingerprint({ agent: 'claude', wslDistro: null, ...identity }),
      'claude',
      listing,
      'discovery'
    )
  }
  expect(await readAgentPickerSavedCatalog('claude', async () => home, store)).toEqual({
    origin: 'unknown'
  })
  store.recordSuccess(
    agentModelCatalogFingerprint({ agent: 'claude', wslDistro: null, accountHome: home }),
    'claude',
    listing,
    'discovery'
  )
  expect(await readAgentPickerSavedCatalog('claude', async () => home, store)).toMatchObject({
    origin: 'probe',
    listingNamesConfiguredModel: false,
    models: [{ id: 'opus', isDefault: false }]
  })
})
