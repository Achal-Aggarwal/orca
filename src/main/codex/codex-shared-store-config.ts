import { basename, dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { resolveEffectiveCodexSqliteHome } from './codex-sqlite-home'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

export const CODEX_SHARED_STORE_MARKER = '# orca: shared conversation store'

export function stripCodexSharedStoreConfig(config: string): string {
  return config
    .split('\n')
    .filter((line) => !line.trimEnd().endsWith(CODEX_SHARED_STORE_MARKER))
    .join('\n')
}

/** Only new overlay configs are ours to point at a conversation store. */
export function applyCodexSharedStoreConfig(config: string, homePath: string): string {
  if (basename(dirname(homePath)) !== 'overlays') {
    return config
  }
  const store = dirname(realpathSync(join(homePath, 'sessions')))
  let state = createTomlLineScanState()
  let topLevel = true
  const lines = stripCodexSharedStoreConfig(config)
    .split('\n')
    .filter((line) => {
      const structural = isTomlStructuralLine(state)
      if (structural && getTomlTableHeader(line)) {
        topLevel = false
      }
      state = updateTomlLineScanState(state, line)
      return !(
        topLevel &&
        structural &&
        /^\s*(?:sqlite_home|cli_auth_credentials_store)\s*=/.test(line)
      )
    })
  return `sqlite_home = ${JSON.stringify(resolveEffectiveCodexSqliteHome(store))} ${CODEX_SHARED_STORE_MARKER}\ncli_auth_credentials_store = "file" ${CODEX_SHARED_STORE_MARKER}\n${lines.join('\n')}`
}
