import { afterEach, describe, expect, it, vi } from 'vitest'
import { attributePortToWorkspace } from './local-workspace-port-attribution'
import { scanWorkspacePorts } from './local-workspace-port-scanner'
import { resetWorkspacePortScanTimeoutBackoffForTests } from './local-workspace-port-scan-state'

const mocks = vi.hoisted(() => ({
  runWslProcess: vi.fn(),
  readWslDistroRunningState: vi.fn()
}))

vi.mock('./port-scan-command-client', () => ({
  runPortScanCommand: () =>
    Promise.resolve({
      stdout: [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    127.0.0.1:8123         0.0.0.0:0              LISTENING       28164',
        '  TCP    127.0.0.1:9000         0.0.0.0:0              LISTENING       28164'
      ].join('\r\n'),
      spawnMs: 5
    }),
  isPortScanWorkerUnavailableError: () => false
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTable: () =>
    Promise.resolve([
      {
        pid: 28164,
        name: 'wslrelay.exe',
        command: 'wslrelay.exe --mode 1 --vm-id {c3e55199} --handle 1908'
      }
    ])
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.runWslProcess }))
vi.mock('../wsl-background-distro-gate', () => ({
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))

// Captured from the guest scan script; 9000 belongs to another distro's PID namespace.
const GUEST_SCAN_OUTPUT = [
  'L 0100007F:1FBB 72172',
  'L 0100007F:2328 72180',
  'S 218149 72172',
  'C 218149 /home/u/repo/web',
  'N 218149 python3',
  'A 218149 python3 -m http.server 8123 --bind 127.0.0.1 '
].join('\n')

const urlWatcher = { lookup: () => undefined, reconcileScan: vi.fn() }
const wslWorkspace = [
  {
    id: 'wt',
    repoId: 'repo',
    displayName: 'repo',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo'
  }
]

describe('WSL listeners forwarded through wslrelay.exe', () => {
  afterEach(() => {
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    mocks.runWslProcess.mockReset()
    mocks.readWslDistroRunningState.mockReset()
  })

  it.each(['\\\\wsl.localhost\\Ubuntu\\home\\u\\repo', '\\\\wsl$\\ubuntu\\home\\u\\repo'])(
    'attributes the guest listener to the WSL workspace at %s',
    async (worktreePath) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      mocks.readWslDistroRunningState.mockResolvedValue('running')
      mocks.runWslProcess.mockResolvedValue({
        code: 0,
        stdout: GUEST_SCAN_OUTPUT,
        stderr: '',
        timedOut: false
      })

      const scan = await scanWorkspacePorts(
        [{ id: 'wt', repoId: 'repo', displayName: 'repo', path: worktreePath }],
        urlWatcher
      )

      const forwarded = scan.ports.find((port) => port.port === 8123)
      expect(forwarded).toMatchObject({
        kind: 'workspace',
        processName: 'python3',
        owner: { worktreeId: 'wt' }
      })
      // The guest PID is not a Windows PID, and the relay PID would stop every forwarded port.
      expect(forwarded?.pid).toBeUndefined()
      expect(scan.ports.find((port) => port.port === 9000)).toMatchObject({
        kind: 'external',
        pid: 28164
      })
    }
  )

  it('does not boot a stopped distro to scan it', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.readWslDistroRunningState.mockResolvedValue('stopped')

    const scan = await scanWorkspacePorts(
      [{ id: 'wt', repoId: 'repo', displayName: 'repo', path: '\\\\wsl.localhost\\Ubuntu\\r' }],
      urlWatcher
    )

    expect(mocks.runWslProcess).not.toHaveBeenCalled()
    expect(scan.ports.every((port) => port.kind === 'external')).toBe(true)
  })

  it('keeps the attribution, and the advertised URL, when one guest read fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    mocks.runWslProcess.mockResolvedValueOnce({
      code: 0,
      stdout: GUEST_SCAN_OUTPUT,
      stderr: '',
      timedOut: false
    })
    await scanWorkspacePorts(wslWorkspace, urlWatcher)
    urlWatcher.reconcileScan.mockClear()
    mocks.runWslProcess.mockResolvedValueOnce({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })

    const scan = await scanWorkspacePorts(wslWorkspace, urlWatcher)

    // A timeout cannot prove the listener gone, so reconciliation must not evict its URL.
    expect(urlWatcher.reconcileScan).not.toHaveBeenCalled()
    const forwarded = scan.ports.find((port) => port.port === 8123)
    expect(forwarded).toMatchObject({ kind: 'workspace', owner: { worktreeId: 'wt' } })
    expect(forwarded?.pid).toBeUndefined()
  })

  it('matches a command line that spells the share differently from the workspace', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const owner = attributePortToWorkspace(
      { commandLine: 'node.exe \\\\wsl$\\Ubuntu\\home\\u\\repo\\server.js' },
      wslWorkspace
    )
    expect(owner?.worktreeId).toBe('wt')
  })

  it('keeps fresh Windows metadata for native ports when a guest read fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.readWslDistroRunningState.mockResolvedValue('unverifiable')

    const scan = await scanWorkspacePorts(wslWorkspace, urlWatcher, { requireMetadata: true })

    expect(scan.ports.find((port) => port.port === 9000)).toMatchObject({
      processName: 'wslrelay.exe',
      pid: 28164
    })
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a command line naming the workspace from outside it',
      ['L 0100007F:1FBB 1', 'S 7 1', 'C 7 /tmp', 'A 7 node /home/u/repo/server.js'],
      'workspace'
    ],
    [
      'one port held by two guest processes',
      ['L 0100007F:1FBB 1', 'L 0101A8C0:1FBB 2', 'S 7 1', 'S 8 2', 'C 7 /home/u/repo', 'C 8 /tmp'],
      'external'
    ]
  ])('classifies %s', async (_label, lines, kind) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    mocks.runWslProcess.mockResolvedValue({
      code: 0,
      stdout: lines.join('\n'),
      stderr: '',
      timedOut: false
    })

    const scan = await scanWorkspacePorts(wslWorkspace, urlWatcher)

    expect(scan.ports.find((port) => port.port === 8123)?.kind).toBe(kind)
  })

  it('treats a clipped guest scan as unread', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    mocks.runWslProcess.mockResolvedValue({
      code: 0,
      stdout: 'L 0100007F:1FBB 72172\nS 218149 72172',
      stderr: '',
      timedOut: false,
      outputTruncated: true
    })
    urlWatcher.reconcileScan.mockClear()

    await scanWorkspacePorts(wslWorkspace, urlWatcher)

    expect(urlWatcher.reconcileScan).not.toHaveBeenCalled()
  })
})
