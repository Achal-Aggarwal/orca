import { structuredAgentSessionSwitchBlocked } from './structured-agent-session-switch-admission'
import { nativeConversationContent } from '../../ai-vault/structured-chat-cli-fork'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import {
  agentSessionLeaseNeverAcquired,
  agentSessionLeasePossiblyWriting
} from '../../../shared/agent-session-lease-adjudication'
import {
  createRestTestRig,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as caller
} from './structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from './structured-agent-session-host-test-data'

let initial: ReturnType<typeof createTestParams>
let rig: RestTestRig
const deadlines: ReturnType<typeof agentSessionSwitchDeadline>[] = []
function clock() {
  let now = 0
  const deadline = agentSessionSwitchDeadline(() => now, 720_000)
  deadlines.push(deadline)
  return {
    deadline,
    expire: () => {
      now = 720_001
    }
  }
}
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  initial = createTestParams()
  expect(await rig.host.create(caller, initial)).toMatchObject({ ok: true })
})
afterEach(async () => {
  deadlines.forEach((deadline) => deadline.dispose())
  deadlines.length = 0
  await rig.dispose()
  vi.restoreAllMocks()
})

it('admits an idle held child with no active turn and nothing delivering', async () => {
  expect(await rig.host.switchToChat(id)).toMatchObject({ ok: true })
  const session = rig.host.collaboratorsForTests().sessions.get(id)!
  expect(session.child).not.toBeNull()
  expect(session.journal.runningTurn()).toBeNull()
  expect(
    structuredAgentSessionSwitchBlocked({
      session,
      deps: rig.host.deps,
      sessionId: id,
      delivering: false,
      background: false
    })
  ).toBeNull()
})

it('joins the command across its own resource close, without holding the session queue while waiting', async () => {
  const { deadline } = clock()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const run = vi.fn(async () => {
    await rig.host.switchToTerminal(id, deadline)
    entered.resolve()
    await release.promise
    return { status: 'completed' as const, sessionId: id }
  })
  const first = rig.host.runSwitch(id, 'same-click', deadline, run)
  await entered.promise
  expect(rig.host.hasSession(id)).toBe(false)
  expect(rig.host.switchExecuting(id)).toBe(true)
  const duplicate = rig.host.runSwitch(id, 'same-click', deadline, run)
  await expect(rig.host.runSwitch(id, 'another-click', deadline, run)).rejects.toMatchObject({
    refusal: { details: { reason: 'handoffInFlight' } }
  })
  release.resolve()
  expect(await first).toEqual(await duplicate)
  expect(run).toHaveBeenCalledOnce()
})

it('revokes a command queued before expiry without executing its later effect', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  // A create publication occupies the real nonreentrant session queue.
  const create = rig.host.create(caller, initial, {
    publishTab: async () => {
      entered.resolve()
      await release.promise
    }
  })
  await entered.promise
  const time = clock()
  const effect = vi.fn(async () => ({ status: 'completed' as const, sessionId: id }))
  const waiting = rig.host.runSwitch(id, 'queued', time.deadline, effect)
  const refused = expect(waiting).rejects.toMatchObject({
    refusal: { code: 'agent_session_operation_expired' }
  })
  time.expire()
  release.resolve()
  await create
  await refused
  expect(effect).not.toHaveBeenCalled()
})

it('checks expiry in the actual reservation transaction after the earlier acquire check', async () => {
  const time = clock()
  const reserve = rig.store.reserveOwner
  vi.spyOn(rig.store, 'reserveOwner').mockImplementation((request, check) => {
    time.expire()
    return reserve(request, check)
  })
  expect(await rig.host.switchToChat(id, time.deadline)).toMatchObject({ ok: false })
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(agentSessionLeaseNeverAcquired(rig.store.getRecord(id)!.lease)).toBe(true)
})

it('shares the full never-acquired proof, while recovery-released ownership stays unavailable after restart', async () => {
  const { deadline } = clock()
  const founding = rig.store.getRecord(id)!.lease
  expect(agentSessionLeaseNeverAcquired(founding)).toBe(true)
  expect(agentSessionLeasePossiblyWriting(founding)).toBe(false)
  await rig.host.switchToTerminal(id, deadline)
  // Recovery can release without observing death: fence 1 alone must not grant a writer.
  await rig.store.transitionHandoff(id, (record) => ({
    ...record,
    lease: { ...record.lease, minimumNextFence: 2 }
  }))
  expect(agentSessionLeasePossiblyWriting(rig.store.getRecord(id)!.lease)).toBe(true)
  await rig.restart()
  await expect(rig.host.switchToTerminal(id, deadline)).rejects.toMatchObject({
    refusal: { details: { reason: 'previousExitUnverifiable' } }
  })
  expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  expect((await rig.host.journalSnapshot(id)).items).toBeDefined()
})

it('preserves accepted work before retirement and never aborts the send that starts it', async () => {
  const { deadline } = clock()
  await rig.host.revealSession(id)
  const current = rig.host.captureSwitchWork(id, deadline)
  expect(current()).toBe(true)
  const accepted = await rig.host.send(caller, restTestSend('Implement the CLI change', 1))
  expect(accepted.ok).toBe(true)
  expect(current()).toBe(false)
  await expect(rig.host.switchToTerminal(id, deadline)).rejects.toHaveProperty('refusal')
  expect(rig.adapter.closeSession).not.toHaveBeenCalled()
})

it('rechecks source work at the actual queued visibility transaction and never retires a different tab', async () => {
  await rig.store.setSessionTabVisibility(id, false)
  await rig.store.setSessionTabVisibility(id, true, 'source-tab')
  let current = true
  const late = rig.store.setSwitchedSessionTabVisibility(id, 'source-tab', false, () => current)
  current = false
  expect(await late).toBe(false)
  expect(rig.store.getSessionTabId(id)).toBe('source-tab')
  expect(
    await rig.store.setSwitchedSessionTabVisibility(id, 'another-tab', false, () => true)
  ).toBe(false)
  expect(rig.store.getSessionTabId(id)).toBe('source-tab')
})

it('accepts the first send against an empty transfer and revokes only the unsent switch effects', async () => {
  const { deadline } = clock()
  const empty = Promise.withResolvers<void>()
  const continueSwitch = Promise.withResolvers<void>()
  const physicalCreate = vi.fn()
  await rig.host.revealSession(id)
  const operation = rig.host.runSwitch(id, 'empty-first-send', deadline, async () => {
    expect(nativeConversationContent(await rig.host.journalSnapshot(id))).toBe('empty')
    empty.resolve()
    await continueSwitch.promise
    await rig.host.switchToTerminal(id, deadline)
    deadline.check()
    physicalCreate()
    return { status: 'completed', sessionId: id }
  })
  const refused = expect(operation).rejects.toHaveProperty('refusal')
  await empty.promise
  const accepted = await rig.host.send(caller, restTestSend('Keep this first message', 1))
  expect(accepted.ok).toBe(true)
  continueSwitch.resolve()
  await refused
  expect(physicalCreate).not.toHaveBeenCalled()
  expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  expect((await rig.host.journalSnapshot(id)).items.length).toBeGreaterThan(0)
})

it('accepts immediately and waits only the prior physical acquisition before starting the accepted send', async () => {
  const { deadline } = clock()
  const entered = Promise.withResolvers<void>()
  const physical = Promise.withResolvers<void>()
  const operation = rig.host.runSwitch(id, 'prior-physical', deadline, async () => {
    const acquisition = rig.host.trackSwitchPhysical(id, physical.promise)
    entered.resolve()
    await acquisition
    return { status: 'completed', sessionId: id }
  })
  await entered.promise
  const accepted = await rig.host.send(
    caller,
    restTestSend('Continue after the old launch settles', 1)
  )
  expect(accepted.ok).toBe(true)
  expect(deadline.signal.aborted).toBe(true)
  const start = rig.host.switchToChat(id)
  await rig.host.journalSnapshot(id)
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  physical.resolve()
  await operation
  expect(await start).toMatchObject({ ok: true })
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
})

it('ordinary Close revokes a queued retention writer instead of resurrecting the source', async () => {
  const { deadline } = clock()
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const restoring = Promise.withResolvers<void>()
  const write = Promise.withResolvers<void>()
  const retained = vi.fn(async (check: () => void) => {
    restoring.resolve()
    await write.promise
    await rig.store.setSessionTabVisibility(id, true, undefined, check)
  })
  const operation = rig.host.runSwitch(
    id,
    'close-during-retain',
    deadline,
    async () => {
      started.resolve()
      await finish.promise
      return { status: 'completed', sessionId: id }
    },
    true,
    undefined,
    retained
  )
  await started.promise
  const retain = rig.host.retainSwitch(id)
  const rejected = expect(retain).rejects.toHaveProperty('refusal')
  await restoring.promise
  await rig.host.close(id, 'user-close')
  await rig.store.setSessionTabVisibility(id, false)
  write.resolve()
  await rejected
  finish.resolve()
  await operation
  expect(rig.store.getSessionTabId(id)).toBeNull()
})

it('expiry retains a source through the command owner and cannot restore after external Close', async () => {
  const { deadline } = clock()
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const retained = vi.fn(async (check: () => void) => {
    check()
    await rig.store.setSessionTabVisibility(id, true, undefined, check)
  })
  const operation = rig.host.runSwitch(
    id,
    'expire-retain',
    deadline,
    async () => {
      started.resolve()
      await finish.promise
      return { status: 'completed', sessionId: id }
    },
    true,
    undefined,
    retained
  )
  await started.promise
  deadline.revoke()
  await rig.host.retainSwitch(id)
  expect(rig.store.getSessionTabId(id)).not.toBeNull()
  await rig.host.close(id, 'user-close')
  await rig.store.setSessionTabVisibility(id, false)
  await expect(rig.host.retainSwitch(id)).rejects.toHaveProperty('refusal')
  finish.resolve()
  await operation
  expect(rig.store.getSessionTabId(id)).toBeNull()
})
