import type { AppState } from '@/store/types'

/** The distro of a WSL host whose last status says it stopped; null for any other host. */
export function selectStoppedWslDistro(
  state: Pick<AppState, 'wslHostStatuses'>,
  environmentId: string | null | undefined
): string | null {
  const status = environmentId ? state.wslHostStatuses[environmentId] : undefined
  return status?.state === 'distro-stopped' ? status.distro : null
}
