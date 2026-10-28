import { sha256 } from '@noble/hashes/sha256'
import { expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import { createGenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { download } from './mobile-web-shell-session-effects'
import type { MobileWebShellSessionEvent } from './mobile-web-shell-session-contract'

vi.mock('expo-crypto', async () => {
  const { sha256: hash } = await import('@noble/hashes/sha256')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, bytes: Uint8Array) => hash(bytes).buffer
  }
})
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))

function gate() {
  let release = (): void => {}
  const settled = new Promise<void>((resolve) => {
    release = resolve
  })
  return { settled, release }
}

function bundle(count: number, seed: number): MobileWebBundleFetchResult {
  const contents = Array.from({ length: count }, (_, index) =>
    new Uint8Array(1024).fill(seed + index)
  )
  const assets = contents.map((bytes, index) => ({
    path: `assets/${String(index).padStart(3, '0')}.js`,
    byteLength: bytes.byteLength,
    sha256: Buffer.from(sha256(bytes)).toString('hex'),
    contentType: 'text/javascript'
  }))
  return {
    manifest: {
      schemaVersion: 1,
      buildId: computeMobileWebBundleId(assets),
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 2,
      entrypoint: assets[0]!.path,
      totalBytes: count * 1024,
      assets
    },
    assets: new Map(assets.map((asset, index) => [asset.path, contents[index]!])),
    reused: [],
    totalBytes: count * 1024,
    elapsedMs: 0
  }
}

function bundleHost(result: MobileWebBundleFetchResult, delayManifest?: ReturnType<typeof gate>) {
  const requested = gate()
  const client: RpcClient = {
    sendRequest: async (method, params): Promise<RpcResponse> => {
      if (method === 'mobileWeb.bundle.manifest') {
        requested.release()
        await delayManifest?.settled
        return {
          id: 'manifest',
          ok: true,
          result: { manifest: result.manifest, chunkBytes: 1024 },
          _meta: { runtimeId: 'stage' }
        }
      }
      if (
        method !== 'mobileWeb.bundle.chunk' ||
        params === null ||
        typeof params !== 'object' ||
        !('path' in params) ||
        typeof params.path !== 'string'
      ) {
        throw new Error('Unexpected bundle request')
      }
      const asset = result.manifest.assets.find((entry) => entry.path === params.path)
      const bytes = result.assets.get(params.path)
      if (asset === undefined || bytes === undefined) {
        throw new Error('Unknown asset')
      }
      return {
        id: 'chunk',
        ok: true,
        result: {
          buildId: result.manifest.buildId,
          path: asset.path,
          offset: 0,
          assetByteLength: asset.byteLength,
          sha256: asset.sha256,
          dataBase64: Buffer.from(bytes).toString('base64'),
          eof: true
        },
        _meta: { runtimeId: 'stage' }
      }
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, requested }
}

it.each([8, 80])(
  'skips canceled queued staging for %i assets and activates a live successor',
  async (count) => {
    const initial = bundle(1, 250)
    const obsolete = bundle(count, 1)
    const live = bundle(count, 100)
    const hostKey = deriveHostCacheKey('stage-host')
    const blockerKey = deriveHostCacheKey('blocker-host')
    const fs = createFakeGenerationFileSystem()
    const blockerEntered = gate()
    const releaseBlocker = gate()
    const writes: { uri: string; bytes: number }[] = []
    const store = createGenerationStore({
      fileSystem: {
        ...fs,
        list: async (uri) => {
          if (uri.endsWith(`/${blockerKey}/generations`)) {
            blockerEntered.release()
            await releaseBlocker.settled
          }
          return fs.list(uri)
        },
        writeBytes: async (uri, bytes) => {
          writes.push({ uri, bytes: bytes.byteLength })
          await fs.writeBytes(uri, bytes)
        }
      }
    })
    await store.commitGeneration(await store.stageGeneration(hostKey, initial))
    const releaseManifest = gate()
    const oldHost = bundleHost(obsolete, releaseManifest)
    const oldDownloads = new Set<AbortController>()
    const staged = gate()
    const oldEvents: MobileWebShellSessionEvent[] = []
    const runtime = {
      createStore: () => store,
      mintSessionId: () => 'live-session',
      now: () => 0,
      setTimer: () => () => {}
    }
    const oldRun = download({
      client: oldHost.client,
      store,
      hostKey,
      flow: 1,
      runtime,
      startedAt: 0,
      downloads: oldDownloads,
      send: (event) => {
        oldEvents.push(event)
        if (event.type === 'download-staged') {
          staged.release()
        }
      }
    })
    await oldHost.requested.settled
    const blocker = store.readActiveGeneration(blockerKey)
    await blockerEntered.settled
    releaseManifest.release()
    await staged.settled
    expect(
      writes.filter((write) => write.uri.includes(`/tmp/${obsolete.manifest.buildId}/`))
    ).toEqual([])
    oldDownloads.forEach((controller) => controller.abort())
    const liveEvents: MobileWebShellSessionEvent[] = []
    const liveDownloads = new Set<AbortController>()
    const releaseLiveManifest = gate()
    const liveHost = bundleHost(live, releaseLiveManifest)
    const liveRun = download({
      client: liveHost.client,
      store,
      hostKey,
      flow: 2,
      runtime,
      startedAt: 0,
      downloads: liveDownloads,
      send: (event) => liveEvents.push(event)
    })
    releaseBlocker.release()
    await Promise.all([blocker, oldRun, liveHost.requested.settled])
    expect((await store.readActiveGeneration(hostKey))?.buildId).toBe(initial.manifest.buildId)
    releaseLiveManifest.release()
    await liveRun
    expect((await store.readActiveGeneration(hostKey))?.buildId).toBe(live.manifest.buildId)
    expect(oldEvents.some((event) => event.type === 'activated')).toBe(false)
    expect(liveEvents).toContainEqual(
      expect.objectContaining({ type: 'activated', buildId: live.manifest.buildId })
    )
    for (const [path, bytes] of live.assets) {
      expect(fs.bytes(`${hostKey}/generations/${live.manifest.buildId}/${path}`)).toEqual(bytes)
    }
    expect(oldDownloads.size).toBe(0)
    expect(liveDownloads.size).toBe(0)
    const obsoleteWrites = writes.filter((write) =>
      write.uri.includes(`/tmp/${obsolete.manifest.buildId}/`)
    )
    expect({
      writes: obsoleteWrites.length,
      bytes: obsoleteWrites.reduce((sum, write) => sum + write.bytes, 0)
    }).toEqual({ writes: 0, bytes: 0 })
  }
)
