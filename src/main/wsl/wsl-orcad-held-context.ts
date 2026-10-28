import { resolveOrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import {
  remoteHostPlatformFromUnameProbe,
  UNAME_PLATFORM_PROBE_COMMAND
} from '../ssh/ssh-remote-platform-detection'
import type { WslDistroHolder } from './wsl-distro-holder'
import { refuseMissingWslDistro, WslDistroVersion1Error } from './wsl-distro-unsupported'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

const WSL_HOST_FACTS_COMMAND = `printf '%s\\n' "$(uname -r)" "$HOME"; ${UNAME_PLATFORM_PROBE_COMMAND}`

/** WSL 1 runs no Linux kernel, so the pinned Node and its pty cannot run there. */
export function isWsl1KernelRelease(release: string): boolean {
  return /^\d+\.\d+\.\d+-\d+-Microsoft$/.test(release.trim())
}

/**
 * Refuses WSL 1, then acquires the holder alongside the read-only context probes: the kernel probe
 * already started the distro, so the holder spawns nothing extra, and it is held before the caller
 * may launch orcad (recovery included) or WSL could idle-stop its distro.
 */
export async function holdWslDistroWithContext(
  name: string,
  target: WslOrcadHostTarget,
  conn: OrcadHostTransport,
  holder: WslDistroHolder,
  signal: AbortSignal | undefined
) {
  // One exec for the kernel, the login home and the platform the context would probe one by one.
  const output = await execCommand(conn, WSL_HOST_FACTS_COMMAND, { signal }).catch(
    refuseMissingWslDistro(name)
  )
  const [kernel = '', loginHome = ''] = output.split('\n')
  if (isWsl1KernelRelease(kernel)) {
    throw new WslDistroVersion1Error(name)
  }
  const platform = remoteHostPlatformFromUnameProbe(output) ?? undefined
  // Once the hold fails, stop the probes: after dispose they fall back to fresh wsl.exe execs,
  // which would boot a distro that just went away (E9).
  const probes = new AbortController()
  if (signal?.aborted) {
    probes.abort(signal.reason)
  }
  const stopProbes = (): void => probes.abort(signal?.reason)
  signal?.addEventListener('abort', stopProbes, { once: true })
  try {
    const [held, context] = await Promise.all([
      holder.ensureHeld(name).catch((error: unknown) => {
        probes.abort(error)
        throw error
      }),
      resolveOrcadRemoteContext(target, conn, probes.signal, platform, loginHome || undefined)
    ])
    return { held, context }
  } catch (error) {
    probes.abort(error)
    throw error
  } finally {
    signal?.removeEventListener('abort', stopProbes)
  }
}
