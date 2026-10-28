import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWebAuthnAccountRequest } from '../../shared/browser-webauthn-account'

const fake = vi.hoisted(() => ({
  fromFrame: vi.fn(),
  rendererContext: vi.fn()
}))

vi.mock('electron', () => ({ webContents: { fromFrame: fake.fromFrame } }))
vi.mock('./browser-manager', () => ({
  browserManager: { getRendererContextForGuest: fake.rendererContext }
}))

import {
  clearBrowserWebAuthnAccessHandlers,
  installBrowserWebAuthnAccessHandlers
} from './browser-webauthn-access'
import {
  BROWSER_WEBAUTHN_ACCOUNT_PICKER_TIMEOUT_MS,
  cancelAllBrowserWebAuthnAccountRequests,
  respondToBrowserWebAuthnAccountRequest
} from './browser-webauthn-account-picker'

const LIFETIME_EVENTS = ['did-navigate', 'render-process-gone', 'destroyed'] as const

function nativeContents(id: number) {
  const requested = new Map<string, BrowserWebAuthnAccountRequest>()
  const closed: string[] = []
  const contents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: { url: 'https://accounts.example.test/' },
    isDestroyed: vi.fn(() => false),
    requested,
    closed,
    send: vi.fn(
      (channel: string, payload: BrowserWebAuthnAccountRequest | { requestId: string }) => {
        if (channel === 'browser:webauthn-account-requested' && 'accounts' in payload) {
          requested.set(payload.requestId, payload)
        }
        if (channel === 'browser:webauthn-account-request-closed') {
          requested.delete(payload.requestId)
          closed.push(payload.requestId)
        }
      }
    )
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The native double implements every WebContents/frame member read by this route.
  return contents as Electron.WebContents & typeof contents
}

function nativeSession() {
  const session = Object.assign(new EventEmitter(), { setDevicePermissionHandler: vi.fn() })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Session install/clear uses only EventEmitter and this permission setter.
  return session as Electron.Session & typeof session
}

type NativeContents = ReturnType<typeof nativeContents>
type NativeSession = ReturnType<typeof nativeSession>
const sessions = new Set<NativeSession>()
const guestsByFrame = new Map<Electron.WebFrameMain, NativeContents>()
const contextsByGuest = new Map<number, { browserPageId: string; renderer: NativeContents }>()

function owner(guestId = 1, renderer = nativeContents(100), session = nativeSession()) {
  const guest = nativeContents(guestId)
  guestsByFrame.set(guest.mainFrame, guest)
  contextsByGuest.set(guest.id, { browserPageId: `page-${guest.id}`, renderer })
  if (!sessions.has(session)) {
    installBrowserWebAuthnAccessHandlers(session)
    sessions.add(session)
  }
  return { guest, renderer, session }
}

function selectAccounts(
  context: ReturnType<typeof owner>,
  callback = vi.fn<(credentialId?: string | null) => void>()
) {
  const handler = context.session.listeners('select-webauthn-account')[0]
  if (!handler) {
    throw new Error('Missing production WebAuthn session handler')
  }
  const existing = new Set(context.renderer.requested.keys())
  const pending = Promise.resolve(
    handler(
      { preventDefault: vi.fn() },
      {
        frame: context.guest.mainFrame,
        relyingPartyId: 'accounts.example.test',
        accounts: [{ credentialId: 'personal' }, { credentialId: 'work' }]
      },
      callback
    )
  )
  const requestId = [...context.renderer.requested.keys()].find((id) => !existing.has(id))
  if (!requestId) {
    throw new Error('Production picker did not publish its request')
  }
  return { pending, callback, requestId }
}

function respond(
  context: ReturnType<typeof owner>,
  requestId: string,
  credentialId: string | null = 'personal'
) {
  return respondToBrowserWebAuthnAccountRequest(context.renderer, { requestId, credentialId })
}

function expectReleased(context: ReturnType<typeof owner>): void {
  expect(context.renderer.requested.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  for (const contents of [context.guest, context.renderer]) {
    for (const event of LIFETIME_EVENTS) {
      expect(contents.listenerCount(event)).toBe(0)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  fake.fromFrame.mockImplementation((frame) => guestsByFrame.get(frame))
  fake.rendererContext.mockImplementation((id: number) => contextsByGuest.get(id))
})

afterEach(() => {
  cancelAllBrowserWebAuthnAccountRequests()
  for (const session of sessions) {
    clearBrowserWebAuthnAccessHandlers(session)
  }
  sessions.clear()
  guestsByFrame.clear()
  contextsByGuest.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('production WebAuthn picker document ownership', () => {
  it.each(['guest', 'renderer'] as const)(
    'retires %s committed navigation before any late account response',
    async (target) => {
      const context = owner()
      const request = selectAccounts(context)
      expect(context.renderer.requested.size).toBe(1)
      context[target].emit('did-navigate', {}, 'https://replacement.example.test/')
      await vi.advanceTimersByTimeAsync(0)

      expectReleased(context)
      await request.pending
      expect(request.callback).toHaveBeenCalledExactlyOnceWith(null)
      expect(context.renderer.closed).toEqual([request.requestId])
      expect(respond(context, request.requestId)).toBe(false)
      for (const contents of [context.guest, context.renderer]) {
        contents.emit('render-process-gone')
        contents.emit('destroyed')
      }
      await vi.advanceTimersByTimeAsync(BROWSER_WEBAUTHN_ACCOUNT_PICKER_TIMEOUT_MS)
      expect(request.callback).toHaveBeenCalledOnce()
      expect(context.renderer.closed).toHaveLength(1)
    }
  )

  it.each(['guest', 'renderer'] as const)(
    'keeps %s same-document and uncommitted navigation live',
    async (target) => {
      const context = owner()
      const request = selectAccounts(context)
      context[target].emit('did-navigate-in-page', {}, 'https://accounts.example.test/#section')
      context[target].emit('will-navigate', {}, 'https://blocked.example.test/')
      context[target].emit('did-start-navigation', {}, 'https://pending.example.test/')
      await vi.advanceTimersByTimeAsync(0)
      expect(request.callback).not.toHaveBeenCalled()
      expect(context.renderer.requested.has(request.requestId)).toBe(true)
      expect(respond(context, request.requestId, 'work')).toBe(true)
      await request.pending
      expect(request.callback).toHaveBeenCalledExactlyOnceWith('work')
      expectReleased(context)
    }
  )

  it.each(['render-process-gone', 'destroyed'] as const)(
    'still cancels both native owners on %s',
    async (event) => {
      for (const target of ['guest', 'renderer'] as const) {
        const context = owner()
        const request = selectAccounts(context)
        context[target].emit(event)
        await request.pending
        expect(request.callback).toHaveBeenCalledExactlyOnceWith(null)
        expect(respond(context, request.requestId)).toBe(false)
        expectReleased(context)
      }
    }
  )

  it('keeps a sibling and a replacement document independent of the retired request', async () => {
    const first = owner()
    const sibling = owner(2, first.renderer, first.session)
    const retired = selectAccounts(first)
    const surviving = selectAccounts(sibling)
    first.guest.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(0)
    expect(retired.callback).toHaveBeenCalledExactlyOnceWith(null)
    expect(surviving.callback).not.toHaveBeenCalled()
    expect(first.renderer.requested.has(surviving.requestId)).toBe(true)
    expect(first.renderer.closed).toEqual([retired.requestId])
    expect(respond(first, retired.requestId)).toBe(false)

    const replacement = selectAccounts(first)
    expect(respond(first, retired.requestId, null)).toBe(false)
    expect(respond(first, replacement.requestId, 'work')).toBe(true)
    expect(respond(sibling, surviving.requestId)).toBe(true)
    await Promise.all([retired.pending, replacement.pending, surviving.pending])
    expect(replacement.callback).toHaveBeenCalledExactlyOnceWith('work')
    expect(surviving.callback).toHaveBeenCalledExactlyOnceWith('personal')
    expectReleased(first)
    expectReleased(sibling)
  })

  it('retiring a main document leaves a separate window live', async () => {
    const first = owner()
    const otherWindow = owner(2, nativeContents(200), first.session)
    const retired = selectAccounts(first)
    const live = selectAccounts(otherWindow)
    first.renderer.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(0)
    expect(retired.callback).toHaveBeenCalledExactlyOnceWith(null)
    expect(live.callback).not.toHaveBeenCalled()
    expect(respond(otherWindow, live.requestId)).toBe(true)
    await Promise.all([retired.pending, live.pending])
    expect(live.callback).toHaveBeenCalledExactlyOnceWith('personal')
    expectReleased(first)
    expectReleased(otherWindow)
  })

  it('cleans up after timeout and session retirement without affecting another session', async () => {
    const first = owner()
    const second = owner(2, first.renderer)
    const retired = selectAccounts(first)
    const live = selectAccounts(second)
    clearBrowserWebAuthnAccessHandlers(first.session)
    await retired.pending
    expect(retired.callback).toHaveBeenCalledExactlyOnceWith(null)
    expect(live.callback).not.toHaveBeenCalled()
    expect(first.renderer.requested.has(live.requestId)).toBe(true)
    expect(respond(first, retired.requestId)).toBe(false)

    await vi.advanceTimersByTimeAsync(BROWSER_WEBAUTHN_ACCOUNT_PICKER_TIMEOUT_MS)
    await live.pending
    expect(live.callback).toHaveBeenCalledExactlyOnceWith(null)
    expect(respond(second, live.requestId)).toBe(false)
    expectReleased(first)
    expectReleased(second)
  })

  it('disposes listeners when publishing the prompt fails', async () => {
    const context = owner()
    context.renderer.send.mockImplementation(() => {
      throw new Error('renderer unavailable')
    })
    const handler = context.session.listeners('select-webauthn-account')[0]
    if (!handler) {
      throw new Error('Missing production WebAuthn session handler')
    }
    const callback = vi.fn()
    await handler(
      { preventDefault: vi.fn() },
      {
        frame: context.guest.mainFrame,
        accounts: [{ credentialId: 'first' }, { credentialId: 'second' }]
      },
      callback
    )
    expect(callback).toHaveBeenCalledExactlyOnceWith(null)
    expectReleased(context)
  })

  it('settles once even when closing the renderer prompt throws', async () => {
    const context = owner()
    const request = selectAccounts(context)
    context.renderer.send.mockImplementation(() => {
      throw new Error('renderer disappeared')
    })
    context.guest.emit('destroyed')
    await request.pending
    expect(request.callback).toHaveBeenCalledExactlyOnceWith(null)
    expect(respond(context, request.requestId)).toBe(false)
    context.guest.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(BROWSER_WEBAUTHN_ACCOUNT_PICKER_TIMEOUT_MS)
    expect(request.callback).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    for (const contents of [context.guest, context.renderer]) {
      for (const event of LIFETIME_EVENTS) {
        expect(contents.listenerCount(event)).toBe(0)
      }
    }
  })

  it('releases ten concurrent requests through one native listener per owner/event', async () => {
    const context = owner()
    const added = vi.spyOn(AbortSignal.prototype, 'addEventListener')
    const removed = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
    const requests = Array.from({ length: 10 }, () => selectAccounts(context))
    for (const contents of [context.guest, context.renderer]) {
      for (const event of LIFETIME_EVENTS) {
        expect(contents.listenerCount(event)).toBe(1)
      }
    }
    context.guest.emit('did-navigate')
    await Promise.all(requests.map((request) => request.pending))
    for (const request of requests) {
      expect(request.callback).toHaveBeenCalledExactlyOnceWith(null)
      expect(respond(context, request.requestId)).toBe(false)
    }
    expect(context.renderer.closed).toHaveLength(10)
    expect(added).toHaveBeenCalledTimes(20)
    expect(removed).toHaveBeenCalledTimes(20)
    expect(removed.mock.contexts).toEqual(expect.arrayContaining(added.mock.contexts))
    for (const [event, listener] of added.mock.calls) {
      expect(removed).toHaveBeenCalledWith(event, listener)
    }
    expectReleased(context)
  })

  it('releases resources before a native callback rejection and rejects late responses', async () => {
    const context = owner()
    const error = new Error('native callback rejected')
    const callback = vi.fn<(credentialId?: string | null) => void>(() => {
      throw error
    })
    const request = selectAccounts(context, callback)
    expect(respond(context, request.requestId)).toBe(true)
    await expect(request.pending).rejects.toBe(error)
    expect(callback).toHaveBeenCalledOnce()
    expectReleased(context)
    context.renderer.emit('did-navigate')
    expect(respond(context, request.requestId)).toBe(false)
    expect(callback).toHaveBeenCalledOnce()
  })
})
