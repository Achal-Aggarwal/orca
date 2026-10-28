import type {
  MobileQueuedEditHostFixtureModule,
  MobileCommandMenuHostFixtureModule
} from '../../../shared/mobile-queued-edit-host.test-fixture-contract'
import {
  QueuedMessageEditHoldParams,
  QueuedMessageUpdateParams
} from '../../../shared/rpc-contract/structured-agent-session-queued-edit-params'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_NOW, HOST_TEST_SESSION } from './structured-agent-session-host-test-data'

export { HOST_TEST_NOW as now }

// Keep the real host checked with Node globals; the phone compiler checks the fixture contract.
export const createMobileQueuedEditHostFixture: MobileQueuedEditHostFixtureModule['createMobileQueuedEditHostFixture'] =
  async () => {
    const rig = await createQueuedMessageTestRig()
    const journal = () => rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    return {
      sessionId: HOST_TEST_SESSION,
      start: rig.workingSend,
      insert: (input) => journal().queuedMessages.insert(input),
      read: (messageId) => journal().queuedMessages.get(messageId),
      published: async (messageId) => {
        const result = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
        const row = result.ok
          ? result.page.queuedMessages?.find((entry) => entry.messageId === messageId)
          : undefined
        if (!row) {
          throw new Error('missing published queued message')
        }
        return row
      },
      request: async (method, params) => {
        if (method === 'agentSession.queuedMessageEditHold') {
          return rig.host.queuedMessageEditHold(
            QUEUED_RIG_CALLER,
            QueuedMessageEditHoldParams.parse(params)
          )
        }
        if (method !== 'agentSession.queuedMessageUpdate') {
          throw new Error('unexpected host fixture request')
        }
        const { envelope, ...fields } = QueuedMessageUpdateParams.parse(params)
        return rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
          ...fields,
          envelope: rig.envelope(fields, method, envelope.clientOperationId)
        })
      },
      restart: async () => {
        await rig.restartHostProcess()
        await rig.drafts()
      },
      dispose: rig.dispose
    }
  }

export const createMobileCommandMenuHostFixture: MobileCommandMenuHostFixtureModule['createMobileCommandMenuHostFixture'] =
  async (provider) => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { ClaudeAtRestCommandCatalog } = await import('../../claude/claude-at-rest-commands')
    const { commandDiscoveryRig, OMP, DISCOVERY_SESSION } =
      await import('../../acp/acp-command-discovery.test-fixture')
    const { acpStructuredAgentDefinition } =
      await import('../../acp/acp-structured-agent-definitions')
    const { CLAUDE_STRUCTURED_AGENT } =
      await import('../../claude/claude-structured-agent-definition')
    const { structuredAgentsDeclaringNothing } =
      await import('./structured-agent-session-adapter-router-test-support')
    const { StructuredAgentRegistry } = await import('./structured-agent-registry')
    const { StructuredAgentSessionAdapterRouter } =
      await import('./structured-agent-session-adapter-router')
    const { StructuredAgentSessionHost } = await import('./structured-agent-session-host')
    const { openTestAgentSessionRecordStore } =
      await import('../../runtime/agent-session-record-store-test-harness')
    const { openTestJournalHostDatabase, closeTestJournalHostDatabase } =
      await import('../agent-session-journal/journal-host-database-test-support')
    const { bindAtRestCommandContexts, retireAtRestCommandSettings, retireAtRestCommandContext } =
      await import('./at-rest-command-context')
    const { recordingStructuredAgentSessionLogger } =
      await import('./structured-agent-session-logger-test-support')
    const root = await mkdtemp(join(tmpdir(), 'orca-35069-phone-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    let starts = 0
    const omp =
      provider === 'omp'
        ? await commandDiscoveryRig((child) => {
            starts++
            child.agent.on('session/new', (frame) => {
              child.agent.notify('session/update', {
                sessionId: DISCOVERY_SESSION,
                update: {
                  sessionUpdate: 'available_commands_update',
                  availableCommands: [{ name: 'fast', description: 'Fast', input: { hint: '' } }]
                }
              })
              child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
            })
          })
        : undefined
    const catalog =
      omp?.catalog ??
      new ClaudeAtRestCommandCatalog({
        resolveWorkspacePath: async () => cwd,
        probe: async () => {
          starts++
          return [{ name: 'fast', kind: 'command' }]
        }
      })
    const agents = new StructuredAgentRegistry(
      structuredAgentsDeclaringNothing([
        provider === 'omp' ? acpStructuredAgentDefinition(OMP) : CLAUDE_STRUCTURED_AGENT
      ])
        .registrations()
        .map((registration) => ({
          ...registration,
          adapter: { ...registration.adapter, atRestCommands: catalog }
        }))
    )
    const store = await openTestAgentSessionRecordStore(root)
    const sessionId = 'phone-command-menu'
    await store.reserveOwner({
      sessionId,
      provider,
      accountHome: {
        variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'PI_CODING_AGENT_DIR',
        path: root
      },
      location: {
        executionHostId: 'local',
        workspaceId: 'menu-folder',
        workspaceKind: 'folder',
        wslDistro: null
      },
      expectedFence: null,
      spawnToken: 'spawn',
      claimKeyId: 'key',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'phone',
        operationId: `${HOST_TEST_NOW}-00000000000000000000000000000001`,
        fingerprint: 'menu'
      },
      now: HOST_TEST_NOW
    })
    const host = new StructuredAgentSessionHost({
      agents,
      store,
      adapter: new StructuredAgentSessionAdapterRouter(agents, async () => {}),
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key',
      logger: recordingStructuredAgentSessionLogger().logger,
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    const unbind = bindAtRestCommandContexts([catalog])
    return {
      sessionId,
      starts: () => starts,
      read: () => host.readCommands(sessionId, true),
      subscribe: (emit) =>
        host.subscribe({
          id: 'phone',
          sessionId,
          commandsOnRequest: true,
          boundedFrames: true,
          emit
        }),
      retire: async (scoped) => {
        if (scoped) {
          retireAtRestCommandContext('menu-folder')
        } else {
          retireAtRestCommandSettings(['agentCmdOverrides'])
        }
        await Promise.resolve()
      },
      dispose: async () => {
        unbind()
        await host.flushAllStreamedEvents()
        await omp?.dispose()
        closeTestJournalHostDatabase(root)
        await rm(root, { recursive: true, force: true })
      }
    }
  }
