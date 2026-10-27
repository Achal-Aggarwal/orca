import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import type { WorkspacePortProbe } from '../../shared/workspace-ports'
import { readWslDistroRunningState } from '../wsl-background-distro-gate'
import { runWslProcess } from '../wsl/wsl-runner'
import { parseProcAddress } from './local-workspace-port-address'
import type { ProcessMetadata, RawListeningPort } from './local-workspace-port-scan-state'

const WSL_GUEST_PORT_SCAN_TIMEOUT_MS = 5_000

// One guest process: listening sockets, the PIDs holding them, then each PID's metadata.
const WSL_GUEST_PORT_SCAN_SCRIPT = String.raw`
listeners=$(for f in /proc/net/tcp /proc/net/tcp6; do
  [ -r "$f" ] && awk 'FNR>1 && $4=="0A" {print "L", $2, $10}' "$f"
done)
[ -n "$listeners" ] || exit 0
printf '%s\n' "$listeners"
inodes=$(printf '%s\n' "$listeners" | awk '{print $3}' | tr '\n' ' ')
sockets=$(ls -l /proc/[0-9]*/fd 2>/dev/null | awk -v want="$inodes" '
  BEGIN { n = split(want, w, " "); for (i = 1; i <= n; i++) keep["socket:[" w[i] "]"] = 1 }
  /^\/proc\/[0-9]+\/fd:$/ { split($0, p, "/"); pid = p[3]; next }
  ($NF in keep) { s = $NF; gsub(/[^0-9]/, "", s); print "S", pid, s }
')
[ -n "$sockets" ] || exit 0
printf '%s\n' "$sockets"
for pid in $(printf '%s\n' "$sockets" | awk '{print $2}' | sort -u); do
  printf 'C %s %s\n' "$pid" "$(readlink "/proc/$pid/cwd" 2>/dev/null)"
  printf 'N %s %s\n' "$pid" "$(cat "/proc/$pid/comm" 2>/dev/null)"
  printf 'A %s %s\n' "$pid" "$(tr '\000\n' '  ' < "/proc/$pid/cmdline" 2>/dev/null)"
done
`

type GuestListener = { port: number; pid: number; metadata: ProcessMetadata }

/** WSL2 NAT forwards every guest listener through one wslrelay.exe, which carries no workspace cwd. */
export function isWslRelayListener(port: Pick<RawListeningPort, 'processName'>): boolean {
  return port.processName?.toLowerCase() === 'wslrelay.exe'
}

export function wslDistrosOfWorkspaces(worktrees: readonly WorkspacePortProbe[]): string[] {
  const distros = new Map<string, string>()
  for (const worktree of worktrees) {
    const distro = parseWslUncPath(worktree.path)?.distro
    if (distro && !distros.has(distro.toLowerCase())) {
      distros.set(distro.toLowerCase(), distro)
    }
  }
  return [...distros.values()]
}

/** Guest listeners whose owning process this distro can see, with Windows-form cwd for attribution. */
export function parseWslGuestPortScan(output: string, distro: string): GuestListener[] {
  const listeners: { port: number; inode: number }[] = []
  const pidByInode = new Map<number, number>()
  const metadata = new Map<number, ProcessMetadata>()
  const metadataOf = (pid: number): ProcessMetadata => {
    const existing = metadata.get(pid)
    if (existing) {
      return existing
    }
    const created: ProcessMetadata = {}
    metadata.set(pid, created)
    return created
  }
  for (const line of output.split('\n')) {
    const match = line.match(/^([LSCNA]) (\S+) ?(.*)$/)
    if (!match) {
      continue
    }
    const [, tag, first, rest] = match
    const value = rest.trim()
    if (tag === 'L') {
      const address = parseProcAddress(first)
      const inode = Number.parseInt(value, 10)
      if (address && Number.isSafeInteger(inode) && inode > 0) {
        listeners.push({ port: address.port, inode })
      }
      continue
    }
    const pid = Number.parseInt(first, 10)
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      continue
    }
    if (tag === 'S') {
      const inode = Number.parseInt(value, 10)
      if (Number.isSafeInteger(inode)) {
        pidByInode.set(inode, pid)
      }
    } else if (tag === 'C' && value.startsWith('/')) {
      metadataOf(pid).cwd = toWindowsWslUncPath(value, distro)
    } else if (tag === 'N' && value) {
      metadataOf(pid).processName = value
    } else if (tag === 'A' && value) {
      metadataOf(pid).commandLine = toUncCommandLine(value, distro)
    }
  }
  return listeners.flatMap(({ port, inode }) => {
    const pid = pidByInode.get(inode)
    return pid === undefined
      ? []
      : [{ port, pid, metadata: { ...metadata.get(pid), wslGuest: { distro, pid } } }]
  })
}

/** Absolute guest paths in UNC form, so command-line attribution compares like with like. */
function toUncCommandLine(commandLine: string, distro: string): string {
  return commandLine.replace(
    /(^|[\s="'])(\/[^\s"']*)/g,
    (_match, lead: string, guestPath: string) => `${lead}${toWindowsWslUncPath(guestPath, distro)}`
  )
}

/** Null when the guest could not be read, which says nothing about its listeners. */
async function scanWslGuestListeners(distro: string): Promise<GuestListener[] | null> {
  const state = await readWslDistroRunningState(distro).catch(() => 'unverifiable' as const)
  // Background scans must not boot a stopped distro.
  if (state !== 'running') {
    return state === 'stopped' ? [] : null
  }
  const result = await runWslProcess({
    distro,
    script: WSL_GUEST_PORT_SCAN_SCRIPT,
    loginPath: 'none',
    timeoutMs: WSL_GUEST_PORT_SCAN_TIMEOUT_MS,
    maxOutputBytes: 4 * 1024 * 1024
  }).catch(() => null)
  // Clipped output can drop the metadata that follows the socket records.
  return result && result.code === 0 && !result.timedOut && !result.outputTruncated
    ? parseWslGuestPortScan(result.stdout, distro)
    : null
}

/** Replace wslrelay.exe owners with the guest process behind each forwarded port; null when a guest could not be read. */
export async function attributeWslRelayListeners(
  ports: RawListeningPort[],
  distros: readonly string[],
  scanGuest: (distro: string) => Promise<GuestListener[] | null> = scanWslGuestListeners
): Promise<RawListeningPort[] | null> {
  if (distros.length === 0 || !ports.some(isWslRelayListener)) {
    return ports
  }
  const scans = await Promise.all(distros.map(scanGuest))
  // null marks a port held by more than one guest process: the relay row cannot say which.
  const guestByPort = new Map<number, GuestListener | null>()
  for (const listeners of scans) {
    if (!listeners) {
      return null
    }
    for (const listener of listeners) {
      const seen = guestByPort.get(listener.port)
      guestByPort.set(
        listener.port,
        seen === undefined || seen?.pid === listener.pid ? listener : null
      )
    }
  }
  return ports.map((port) => {
    const guest = isWslRelayListener(port) ? guestByPort.get(port.port) : undefined
    return guest ? { host: port.host, port: port.port, pid: port.pid, ...guest.metadata } : port
  })
}
