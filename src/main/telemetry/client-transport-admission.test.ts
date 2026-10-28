import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PostHogTransport from './posthog-transport'
import {
  _setPostHogClientForTests,
  initTelemetry,
  isTelemetryEnabled,
  persistBannerAcknowledgeWithoutEmitting,
  setOptIn,
  shutdownTelemetry,
  track
} from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'

const transport = vi.hoisted(() => {
  vi.stubGlobal('ORCA_BUILD_IDENTITY', 'stable')
  vi.stubGlobal('ORCA_POSTHOG_WRITE_KEY', 'test-write-key')
  return { create: vi.fn() }
})

vi.mock('./posthog-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof PostHogTransport>()
  return {
    ...actual,
    createPostHogClient: transport.create,
    buildCommonProps: (installId: string, sessionId: string, channel: 'stable' | 'rc') => ({
      app_version: '1.3.33',
      platform: 'darwin',
      arch: 'arm64',
      os_release: '25.3.0',
      install_id: installId,
      session_id: sessionId,
      orca_channel: channel
    })
  }
})

describe('telemetry transport admission', () => {
  let state: TelemetryClientTestState

  beforeEach(() => {
    state = setupTelemetryClientTest({
      optedIn: false,
      installId: BASE_COMMON.install_id,
      existedBeforeTelemetryRelease: false
    })
    _setPostHogClientForTests(null)
    transport.create.mockReturnValue(state.mock)
    transport.create.mockClear()
    initTelemetry(state.store)
  })

  afterEach(() => cleanupTelemetryClientTest(state.envStash))
  afterAll(() => vi.unstubAllGlobals())

  it('keeps disabled startup and shutdown free of an SDK client', async () => {
    expect(isTelemetryEnabled()).toBe(false)
    expect(track('app_opened', {})).toBe(false)
    await shutdownTelemetry()
    expect(transport.create).not.toHaveBeenCalled()
    expect(state.mock.capture).not.toHaveBeenCalled()
    expect(state.mock.shutdown).not.toHaveBeenCalled()
  })

  it.each(['DO_NOT_TRACK', 'ORCA_TELEMETRY_DISABLED', 'CI'])(
    'does not start the SDK when %s overrides an enabled preference',
    (name) => {
      state.settings.telemetry!.optedIn = true
      process.env[name] = '1'
      initTelemetry(state.store)
      expect(isTelemetryEnabled()).toBe(false)
      expect(track('app_opened', {})).toBe(false)
      expect(transport.create).not.toHaveBeenCalled()
    }
  )

  it('starts and shuts down an enabled transport as before', async () => {
    state.settings.telemetry!.optedIn = true
    initTelemetry(state.store)
    expect(transport.create).toHaveBeenCalledExactlyOnceWith('test-write-key', {
      effective: 'enabled'
    })
    expect(track('app_opened', {})).toBe(true)
    await shutdownTelemetry()
    expect(state.mock.shutdown).toHaveBeenCalledWith(2_000)
  })

  it('does not start a client to repeat an existing opt-out', async () => {
    await setOptIn('settings', false)
    expect(state.settings.telemetry?.optedIn).toBe(false)
    expect(transport.create).not.toHaveBeenCalled()
    expect(state.mock.capture).not.toHaveBeenCalled()
  })

  it('creates one client on opt-in and preserves the first app-open event', async () => {
    expect(transport.create).not.toHaveBeenCalled()
    await setOptIn('settings', true)
    expect(transport.create).toHaveBeenCalledExactlyOnceWith('test-write-key', {
      effective: 'enabled'
    })
    expect(isTelemetryEnabled()).toBe(true)
    expect(state.mock.capture.mock.calls.map(([event]) => event.event)).toEqual([
      'app_opened',
      'telemetry_opted_in'
    ])
    await setOptIn('settings', true)
    expect(transport.create).toHaveBeenCalledTimes(1)
    expect(
      state.mock.capture.mock.calls.filter(([event]) => event.event === 'app_opened')
    ).toHaveLength(1)
    expect(state.settings.telemetry?.installId).toBe(BASE_COMMON.install_id)
  })

  it('keeps pending-banner opt-out capture ahead of SDK opt-out', async () => {
    state.settings.telemetry!.optedIn = null
    initTelemetry(state.store)
    expect(transport.create).toHaveBeenCalledExactlyOnceWith('test-write-key', {
      effective: 'pending_banner'
    })
    const order: string[] = []
    state.mock.optOut.mockImplementation(async () => order.push('optOut'))
    state.mock.capture.mockImplementation((message: { event: string; uuid: string }) => {
      queueMicrotask(() => {
        order.push(message.event)
        state.mock.emitForTests('capture', message)
      })
    })
    await setOptIn('settings', false)
    expect(order).toEqual(['telemetry_opted_out', 'optOut'])
  })

  it('enables a previously absent client before acknowledging the banner', async () => {
    await persistBannerAcknowledgeWithoutEmitting()
    expect(transport.create).toHaveBeenCalledTimes(1)
    expect(state.settings.telemetry?.optedIn).toBe(true)
    expect(state.mock.capture.mock.calls.map(([event]) => event.event)).toEqual(['app_opened'])
  })

  it('does not create a client for opt-in after shutdown starts', async () => {
    await shutdownTelemetry()
    await setOptIn('settings', true)
    expect(state.settings.telemetry?.optedIn).toBe(true)
    expect(transport.create).not.toHaveBeenCalled()
    expect(state.mock.capture).not.toHaveBeenCalled()
  })
})
