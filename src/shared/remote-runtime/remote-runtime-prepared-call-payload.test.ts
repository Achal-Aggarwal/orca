import { describe, expect, it } from 'vitest'
import {
  PreparedRemoteRuntimeCallPayload,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  serializePreparedRemoteRuntimeRequest,
  serializeRemoteRuntimeRpcRequest
} from './remote-runtime-memory-limits'

const header = { requestId: 'request', deviceToken: 'new-token', method: 'files.write' }

describe('prepared remote runtime call payload', () => {
  it('normalizes once at admission and uses dispatch-time request identity', () => {
    let visits = 0
    let reads = 0
    const params = {
      toJSON(key: string) {
        visits += 1
        expect(key).toBe('params')
        return {
          get content() {
            reads += 1
            return 'original'
          }
        }
      }
    }
    const evidence = { terminalHandle: 'original-terminal' }
    const envelope = {
      orchestrationCapability: 'capability',
      orchestrationContractVersion: 1,
      orchestrationRequestId: 'orchestration-request',
      compatibilityInvocationId: 'invocation',
      orchestrationCompatibilityEvidence: evidence
    }
    const prepared = new PreparedRemoteRuntimeCallPayload(params, envelope)
    evidence.terminalHandle = 'changed-terminal'
    envelope.orchestrationCapability = 'changed-capability'

    for (const deviceToken of ['new-token', 'replacement-token']) {
      expect(
        JSON.parse(serializeRemoteRuntimeRpcRequest({ ...header, deviceToken, params: prepared }))
      ).toEqual({
        id: 'request',
        deviceToken,
        method: 'files.write',
        params: { content: 'original' },
        orchestrationCapability: 'capability',
        orchestrationContractVersion: 1,
        orchestrationRequestId: 'orchestration-request',
        compatibilityInvocationId: 'invocation',
        orchestrationCompatibilityEvidence: { terminalHandle: 'original-terminal' }
      })
    }
    expect(visits).toBe(1)
    expect(reads).toBe(1)
  })

  it('matches native JSON omission, boxed values, aliases, and non-finite numbers', () => {
    const alias = { text: 'same value' }
    const cases: unknown[] = [
      undefined,
      null,
      () => {},
      Symbol('omitted'),
      Object(3),
      Object('boxed'),
      Object(false),
      [undefined, () => {}, Symbol('array value'), Number.NaN, Number.POSITIVE_INFINITY],
      { first: alias, second: alias, omitted: undefined }
    ]
    for (const params of cases) {
      expect(
        serializeRemoteRuntimeRpcRequest({
          ...header,
          params: new PreparedRemoteRuntimeCallPayload(params)
        })
      ).toBe(
        JSON.stringify({ id: 'request', deviceToken: 'new-token', method: 'files.write', params })
      )
    }
  })

  it('keeps orchestration routing reads independent of the owned wire snapshot', () => {
    const prepared = new PreparedRemoteRuntimeCallPayload({
      peek: true,
      nested: { value: 'saved' }
    })
    const params = prepared.readParams()
    if (typeof params !== 'object' || params === null || !('peek' in params)) {
      throw new Error('Expected snapshotted orchestration parameters')
    }
    params.peek = false
    expect(prepared.readParams()).toEqual({ peek: true, nested: { value: 'saved' } })
  })

  it('preserves token omission after web device-key authentication', () => {
    const params = new PreparedRemoteRuntimeCallPayload({ content: 'saved' })
    expect(
      serializePreparedRemoteRuntimeRequest({ id: 'request', method: 'files.write', params })
    ).toBe('{"id":"request","method":"files.write","params":{"content":"saved"}}')
    expect(
      serializePreparedRemoteRuntimeRequest({ id: 'ordinary', params: { content: 'saved' } })
    ).toBeUndefined()
  })

  it('keeps the complete request limit after adding fresh identity fields', () => {
    const params = new PreparedRemoteRuntimeCallPayload(
      'x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - 13)
    )
    expect(() => serializeRemoteRuntimeRpcRequest({ ...header, params })).toThrow(
      expect.objectContaining({ code: 'invalid_argument' })
    )
  })

  it('rejects unserializable inputs with the existing remote error code', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    for (const params of [
      cycle,
      { value: 1n },
      {
        get value() {
          throw new Error('getter failed')
        }
      }
    ]) {
      expect(() => new PreparedRemoteRuntimeCallPayload(params)).toThrow(
        expect.objectContaining({ code: 'invalid_argument' })
      )
    }
  })
})
