import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { RuntimeClient, RuntimeClientError } from '../../runtime-client'
import { okFixture } from '../../test-fixtures'
import { ORCHESTRATION_WORKER_START_CREATES_RUN_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const client = new RuntimeClient('/tmp/orca-older-runtime-run', 60_000, null, null)
const UNBOUND = new RuntimeClientError(
  'consumer_fenced',
  'worker-start needs the coordinator bound to the Run, or a worker on an active Dispatch in it.'
)

describe('worker-start against a runtime that cannot create the Run itself', () => {
  const methods: string[] = []
  let runCreateParams: unknown

  function stubRuntime(capabilities: string[]): void {
    let starts = 0
    vi.spyOn(client, 'call').mockImplementation(async (method: string, params?: unknown) => {
      methods.push(method)
      if (method === 'status.get') {
        return okFixture('req_status', { capabilities })
      }
      if (method === 'orchestration.runCreate') {
        runCreateParams = params
        return okFixture('req_run', { run: { id: 'run_1', objective: 'Audit the parser' } })
      }
      if (method === 'orchestration.workerStart') {
        starts += 1
        if (starts === 1) {
          throw UNBOUND
        }
        return okFixture('req_start', { state: 'ready', effects: [], residualResources: [] })
      }
      throw new Error(`Unexpected RPC: ${method}`)
    })
  }

  async function start(): Promise<void> {
    await ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags: new Map<string, string | boolean>([
        ['spec', 'Audit the parser\nCheck every branch.'],
        ['terminal', 'term_worker'],
        ['from', 'term_coord']
      ]),
      client,
      cwd: '/tmp/coord',
      json: true
    })
  }

  beforeEach(() => {
    methods.length = 0
    runCreateParams = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('creates the Run as run-create would, then starts the worker once more', async () => {
    stubRuntime([])

    await start()

    expect(methods).toEqual([
      'orchestration.workerStart',
      'status.get',
      'orchestration.runCreate',
      'orchestration.workerStart'
    ])
    expect(runCreateParams).toEqual({ objective: 'Audit the parser', from: 'term_coord' })
  })

  it('leaves the refusal alone when the runtime would have created the Run', async () => {
    stubRuntime([ORCHESTRATION_WORKER_START_CREATES_RUN_RUNTIME_CAPABILITY])

    await expect(start()).rejects.toBe(UNBOUND)
    expect(methods).not.toContain('orchestration.runCreate')
  })
})
