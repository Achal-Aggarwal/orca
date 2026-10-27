import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanWorkspacePorts } from './local-workspace-port-scanner'
import { resetWorkspacePortScanTimeoutBackoffForTests } from './local-workspace-port-scan-state'

const mocks = vi.hoisted(() => ({
  runWslProcess: vi.fn(),
  isWslDistroRunning: vi.fn()
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
vi.mock('../wsl-background-distro-gate', () => ({ isWslDistroRunning: mocks.isWslDistroRunning }))

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

describe('WSL listeners forwarded through wslrelay.exe', () => {
  afterEach(() => {
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    mocks.runWslProcess.mockReset()
    mocks.isWslDistroRunning.mockReset()
  })

  it.each(['\\\\wsl.localhost\\Ubuntu\\home\\u\\repo', '\\\\wsl$\\ubuntu\\home\\u\\repo'])(
    'attributes the guest listener to the WSL workspace at %s',
    async (worktreePath) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      mocks.isWslDistroRunning.mockResolvedValue(true)
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
    mocks.isWslDistroRunning.mockResolvedValue(false)

    const scan = await scanWorkspacePorts(
      [{ id: 'wt', repoId: 'repo', displayName: 'repo', path: '\\\\wsl.localhost\\Ubuntu\\r' }],
      urlWatcher
    )

    expect(mocks.runWslProcess).not.toHaveBeenCalled()
    expect(scan.ports.every((port) => port.kind === 'external')).toBe(true)
  })
})
