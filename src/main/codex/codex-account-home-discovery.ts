import { join } from 'node:path'
import { discoverCodexStoreHomes } from './codex-launch-home'

/** Includes retired accounts and stores selected before a source-home change. */
export function getCodexAccountHomeSessionDirectories(): string[] {
  return discoverCodexStoreHomes().map((home) => join(home, 'sessions'))
}
