// @vitest-environment happy-dom
import { useEffect } from 'react'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SmartWorkspaceSourceDrawer } from '../components/SmartWorkspaceSourceDrawer'
import { useMobileComposerSource } from './use-mobile-composer-source'
import { searchIssues } from '../../../src/main/linear/linear-issue-lookups'
import { credentialDecryptionMessage } from '../../../src/shared/integration-credential-errors'
import { LINEAR_METHODS } from '../../../src/main/runtime/rpc/methods/linear'
import { mapDispatcherError } from '../../../src/main/runtime/rpc/dispatcher-error-response'
import { successResponse } from '../../../src/main/runtime/rpc/errors'
import type { RpcContext } from '../../../src/main/runtime/rpc/core'
import type { RpcClient } from '../transport/rpc-client'

const provider = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../../src/main/linear/client', () => ({
  getClients: () => [
    { workspace: { id: 'w' }, client: { client: { rawRequest: provider.request } } }
  ],
  isAuthError: () => false
}))
vi.mock('../../../src/main/linear/linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('../../../src/main/linear/linear-request-concurrency', () => ({
  acquire: async () => {},
  release: () => {}
}))
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const View = ({ children }: { children?: React.ReactNode }) =>
    createElement('div', null, children)
  return {
    Text: ({ children }: { children?: React.ReactNode }) => createElement('span', null, children),
    View,
    Pressable: ({ children, onPress }: { children?: React.ReactNode; onPress: () => void }) =>
      createElement('button', { onClick: onPress }, children),
    TextInput: () => null,
    FlatList: () => null,
    ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    InteractionManager: { runAfterInteractions: () => ({ cancel: () => {} }) }
  }
})
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: unknown }) => children
}))
vi.mock('../components/SmartSourceModeIcon', () => ({ SmartSourceModeIcon: () => null }))
vi.mock('../components/SmartWorkspaceSourceRow', () => ({ SmartWorkspaceSourceRow: () => null }))

const searchMethod = LINEAR_METHODS.find((method) => method.name === 'linear.searchIssues')!
// SAFETY: only linear.searchIssues is dispatched; the production handler uses this runtime method alone.
const context = { runtime: { linearSearchIssues: searchIssues } } as unknown as RpcContext
const client = {
  sendRequest: async (_method: string, params: unknown) => {
    const request = { id: '1', authToken: '', method: searchMethod.name, params }
    const meta = { runtimeId: 'r' }
    try {
      return successResponse(
        request.id,
        meta,
        await searchMethod.handler(searchMethod.params.parse(params), context)
      )
    } catch (error) {
      return mapDispatcherError(request, meta, error)
    }
  }
  // SAFETY: the mounted search flow uses only sendRequest; no connection methods are called.
} as unknown as RpcClient
const availability = {
  textOnly: false,
  tasksSupported: true,
  hasRepo: false,
  githubAvailable: false,
  gitlabAvailable: false,
  linearAvailable: true,
  jiraAvailable: false
}
const repos: [] = []
function Picker() {
  const composer = useMobileComposerSource({ client, selectedRepoId: null })
  useEffect(() => composer.setName('network issue'), [composer.setName])
  return (
    <SmartWorkspaceSourceDrawer
      visible
      client={client}
      composer={composer}
      availability={availability}
      repoId={null}
      repos={repos}
      linearWorkspaceId="w"
      sshReady={false}
      onRepoChange={() => {}}
      onClose={() => {}}
    />
  )
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it.each([
  ['429: GraphQL request failed private diagnostic', 'Unable to load Linear issues. Try again.'],
  [credentialDecryptionMessage('Linear'), credentialDecryptionMessage('Linear')]
])('renders the real provider rejection safely: %s', async (raw, visible) => {
  provider.request.mockRejectedValue(new Error(raw))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  render(<Picker />)
  fireEvent.click(screen.getByRole('button', { name: 'Linear' }))
  await waitFor(() => expect(screen.queryByText(visible)).not.toBeNull())
  if (raw !== visible) {
    expect(screen.queryByText(raw)).toBeNull()
  }
  expect(warn).toHaveBeenCalledWith(
    '[linear] searchIssues failed:',
    expect.objectContaining({ message: raw })
  )
})
