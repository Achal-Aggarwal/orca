import type { SkillDiscoveryResult } from '../../shared/skills'
import {
  blockedWslDistroForPath,
  wslDistroForPath,
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from '../wsl/wsl-unc-access-gate'
import type { SkillScanRoot } from './skill-discovery-sources'

/**
 * Drops roots on a stopped (or unverifiable) WSL distro: reading `\\wsl.localhost` would start it,
 * and passive UI runs this scan. Left out, not reported missing, so the next scan picks them up.
 */
export async function withoutStoppedWslDistroRoots(
  roots: readonly SkillScanRoot[]
): Promise<SkillScanRoot[]> {
  const blockedByDistro = new Map<string, Promise<boolean>>()
  const blocked = await Promise.all(
    roots.map(async (root) => {
      const distro = wslDistroForPath(root.path)
      if (!distro) {
        return false
      }
      const key = distro.toLowerCase()
      let check = blockedByDistro.get(key)
      if (!check) {
        check = blockedWslDistroForPath(root.path).then((result) => result !== null)
        blockedByDistro.set(key, check)
      }
      return await check
    })
  )
  return roots.filter((_, index) => !blocked[index])
}

/** Whether reading `path` would start a stopped (or unverifiable) WSL distro. */
export async function isOnStoppedWslDistro(path: string): Promise<boolean> {
  return wslDistroForPath(path) !== null && (await blockedWslDistroForPath(path)) !== null
}

/**
 * Discovery for a WSL target whose distro is stopped (or unverifiable) answers "nothing seen yet":
 * no skills and no sources, so nothing reads as missing and the next scan retries.
 */
export async function unavailableWhileWslDistroStopped(
  discover: () => Promise<SkillDiscoveryResult>
): Promise<SkillDiscoveryResult> {
  try {
    return await discover()
  } catch (error) {
    if (error instanceof WslDistroStoppedError || error instanceof WslDistroUnverifiableError) {
      return { skills: [], sources: [], scannedAt: Date.now() }
    }
    throw error
  }
}
