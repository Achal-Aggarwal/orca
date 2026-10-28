import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  mockAsWebContents,
  sendAndReceive
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))

describe('CDP proxy protocol errors', () => {
  let proxy: CdpWsProxy
  let endpoint: string

  beforeEach(async () => {
    proxy = new CdpWsProxy(mockAsWebContents(createMockWebContents()), () => () => {})
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  it('contains an invalid UTF-8 frame and serves the next browser client', async () => {
    const malformed = await connect(endpoint)
    const closed = once(malformed, 'close')
    malformed.send(Buffer.from([0xff]), { binary: false })
    await closed

    const next = await connect(endpoint)
    try {
      expect(await sendAndReceive(next, { id: 1, method: 'Browser.getVersion' })).toMatchObject({
        id: 1,
        result: expect.any(Object)
      })
    } finally {
      next.close()
    }
  })
})
