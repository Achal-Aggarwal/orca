import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { createPostHogSdkBundlePlugin } from '../build-plugins/posthog-sdk-bundle'

const projectDir = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
let outputDir

const smokeScript = `
  const assert = require('node:assert/strict')
  const { createRequire } = require('node:module')
  const { gunzipSync } = require('node:zlib')
  const { join } = require('node:path')
  const fixture = process.argv[1]
  const entry = join(fixture, 'out', 'main', 'factory.cjs')
  const sdkEntry = join(fixture, 'out', 'main', 'posthog-sdk.js')
  const { setAppEnvironment, createPostHogClient } = require(entry)
  setAppEnvironment({ isPackaged: () => false })
  assert.equal(require.cache[sdkEntry], undefined, 'SDK stays unloaded until construction')
  let requests = []
  global.fetch = async (_url, options) => {
    let body = options.body
    if (options.headers['Content-Encoding'] === 'gzip' || options.headers['content-encoding'] === 'gzip') {
      body = gunzipSync(body).toString('utf8')
    }
    const payload = JSON.parse(body)
    delete payload.sent_at
    requests.push(payload)
    return new Response('{}', { status: 200 })
  }
  const compare = async (client) => {
    requests = []
    try {
      client.optOut()
      client.capture({ distinctId: 'fixture', event: 'disabled' })
      await client.flush()
      assert.equal(requests.length, 0)
      client.optIn()
      const enqueued = new Promise((resolve) => {
        const stop = client.on('capture', () => { stop(); resolve() })
      })
      client.capture({ distinctId: 'fixture', event: 'sdk_fixture', uuid: '01900000-0000-7000-8000-000000000000', timestamp: new Date('2026-01-01T00:00:00Z'), properties: { sample: true } })
      await enqueued
      await client.flush()
      assert.equal(requests.length, 1)
      return structuredClone(requests)
    } finally {
      await client.shutdown()
    }
  }
  ;(async () => {
    const bundled = createPostHogClient('ram-fixture', { effective: 'enabled' })
    assert.equal(bundled.constructor.name, 'PostHog')
    assert.ok(require.cache[sdkEntry])
    const bundledPayload = await compare(bundled)
    const { PostHog } = createRequire(entry)('posthog-node')
    const original = new PostHog('ram-fixture', { host: 'https://us.i.posthog.com', flushAt: 20, flushInterval: 10000, disableGeoip: true, maxQueueSize: 5000 })
    const originalPayload = await compare(original)
    assert.deepEqual(bundledPayload, originalPayload)
    console.log('Telemetry SDK capture parity passed')
  })().catch((error) => { console.error(error); process.exitCode = 1 })
`

beforeAll(async () => {
  outputDir = await mkdtemp(join(projectDir, 'node_modules', 'orca-posthog-sdk-runtime-'))
  const entry = join(outputDir, 'factory.ts')
  await writeFile(
    entry,
    `export { createPostHogClient } from ${JSON.stringify(join(projectDir, 'src/main/telemetry/posthog-transport'))}; export { setAppEnvironment } from ${JSON.stringify(join(projectDir, 'src/shared/app-environment'))}`
  )
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [createPostHogSdkBundlePlugin()],
    build: {
      ssr: true,
      emitAssets: true,
      outDir: join(outputDir, 'out', 'main'),
      minify: 'oxc',
      rollupOptions: {
        input: entry,
        output: { format: 'cjs', entryFileNames: 'factory.cjs' }
      }
    }
  })
})

afterAll(async () => {
  if (outputDir) {
    await rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('bundled telemetry SDK runtime', () => {
  it.each([
    { name: 'Node', program: process.execPath },
    { name: 'Electron', program: require('electron') }
  ])('preserves capture and consent behavior under $name without network', async ({ program }) => {
    const result = await runProcess({
      program,
      args: ['-e', smokeScript, outputDir],
      cwd: projectDir,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 20000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout.trim()).toBe('Telemetry SDK capture parity passed')
  })
})
