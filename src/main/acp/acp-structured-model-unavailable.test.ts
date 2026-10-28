import { afterEach, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { GROK_CONFIG_OPTIONS, waitFor } from './acp-structured-adapter.test-support'
import { framesOf, openHostRig, send } from './acp-structured-host.test-support'
import { z } from 'zod'

// CLI source responses: Grok resolve_model_id; OMP #setModelById through RpcConnection's error wrapper.
const refusals = [
  {
    agent: 'grok',
    name: 'Grok',
    code: -32602,
    message: 'Invalid params',
    data: 'unknown model id'
  },
  {
    agent: 'omp',
    name: 'OMP',
    code: -32603,
    message: 'Internal error',
    data: { details: 'Unknown ACP model: retired' }
  }
] as const

afterEach(closeProviderTimelineRigs)

it.each(refusals)(
  '$name keeps a rejected model on repeated sends, then sends after a new pick',
  async (failure) => {
    const spec = acpLaunchSpecFor(failure.agent)!
    const { host, rig, store, ready } = await openHostRig({
      spec,
      script: (agent) =>
        agent.on('session/set_config_option', (frame) => {
          const { configId, value } = z
            .object({ configId: z.string(), value: z.string() })
            .parse(frame.params)
          if (value === 'retired') {
            agent.fail(frame, failure.code, failure.message, failure.data)
          } else {
            agent.reply(frame, {
              configOptions: GROK_CONFIG_OPTIONS.map((option) =>
                option.id === configId ? { ...option, currentValue: value } : option
              )
            })
          }
        })
    })
    const attached = await host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: failure.agent,
        agent: failure.agent,
        providerHandle: undefined,
        accountHome: {
          variable: failure.agent === 'grok' ? 'GROK_HOME' : 'PI_CODING_AGENT_DIR',
          path: '/grok'
        }
      })
    )
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
    await ready()
    const pick = async (value: string) => {
      const fields = { key: 'model', value }
      expect(
        await host.setOption(CALLER, {
          envelope: envelope('agentSession.setOption', fields),
          ...fields
        })
      ).toMatchObject({ ok: true })
    }
    await pick('retired')
    for (const text of ['first attempt', 'second attempt']) {
      const messageId = await send(host, text)
      await waitFor(async () => {
        const snapshot = await host.journalSnapshot(SESSION)
        expect(
          snapshot.submissions.find((entry) => entry.clientMessageId === messageId)
        ).toMatchObject({
          dispatchState: 'rejected',
          rejection: { kind: 'modelUnavailable' },
          reason: `${failure.name} couldn't use retired. Pick another model and send again.`
        })
      })
      expect(store.getRecord(SESSION)?.options?.model).toBe('retired')
      expect((await host.readOptions(SESSION, { readsWithoutModel: true })).current.model).toBe(
        'retired'
      )
      expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(0)
    }
    const failed = await host.journalSnapshot(SESSION)
    expect(
      failed.submissions.filter((entry) => entry.rejection?.kind === 'modelUnavailable')
    ).toHaveLength(2)
    const rows = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    expect(
      rows.filter(
        (row) => row.body.kind === 'status' && row.body.failure?.kind === 'modelUnavailable'
      )
    ).toHaveLength(0)
    await pick('grok-4.7')
    await send(host, 'after a new pick')
    await waitFor(() => expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(1))
    const prompt = framesOf(rig.child(), 'session/prompt')[0]!
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    expect(store.getRecord(SESSION)?.options?.model).toBe('grok-4.7')
    await host.close(SESSION, 'user-close')
  }
)
