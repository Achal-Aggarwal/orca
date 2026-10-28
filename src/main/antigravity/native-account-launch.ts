import { existsSync } from 'node:fs'
import { resolve, win32 } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { tokenizeCommandLine } from '../../shared/agent-command-line-entrypoint'
import {
  getAntigravityWindowsHome,
  isAntigravityWindowsFileHost
} from './native-windows-credentials'
import { getAppEnvironment } from '../../shared/app-environment'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { isAntigravityFileStorageHost } from './native-credential-backend'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { getAntigravityAccountService, getAntigravityAccountVaultPath } from './native-account-host'

export async function prepareAntigravityAccountForLaunch(args: {
  launchAgent?: string
  command?: string
  connectionId?: string | null
  isWsl?: boolean
  env?: NodeJS.ProcessEnv
  envIsComplete?: boolean
  envToDelete?: readonly string[]
}): Promise<void> {
  const agent =
    args.launchAgent ??
    (args.command ? recognizeAgentProcessFromCommandLine(args.command)?.agent : null)
  // Client snapshots never select accounts for a relay or a client-selected distro.
  if (agent !== 'antigravity' || args.connectionId || args.isWsl) {
    return
  }
  const path = getAntigravityAccountVaultPath()
  if (!existsSync(path)) {
    return
  }
  if (!createEncryptedAntigravityAccountStore(path).read().selectedAccountId) {
    return
  }
  const windows = process.platform === 'win32'
  const fold = (source: NodeJS.ProcessEnv = {}) =>
    Object.fromEntries(
      Object.entries(source).map(([key, value]) => [windows ? key.toUpperCase() : key, value])
    )
  const env = args.envIsComplete ? fold(args.env) : { ...fold(process.env), ...fold(args.env) }
  for (const key of args.envToDelete ?? []) {
    delete env[windows ? key.toUpperCase() : key]
  }
  if (windows) {
    const hostHome = getAntigravityWindowsHome(process.env)
    const launchHome = getAntigravityWindowsHome(env)
    let geminiDir = '.gemini'
    let appDir = 'antigravity-cli'
    const tokens = tokenizeCommandLine(args.command ?? '')
    for (let index = 1; index < tokens.length; index++) {
      if (tokens[index] === '--') {
        break
      }
      if (tokens[index] === '--prompt-interactive' || tokens[index] === '-i') {
        index++
        continue
      }
      const flag = /^--?(gemini_dir|app_data_dir)(?:=(.*))?$/.exec(tokens[index])
      if (!flag) {
        continue
      }
      const value = flag[2] ?? tokens[++index] ?? ''
      if (flag[1] === 'gemini_dir') {
        geminiDir = value
      } else {
        appDir = value
      }
    }
    const same = (left: string, right: string) =>
      normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
    if (
      !same(win32.resolve(launchHome), win32.resolve(hostHome)) ||
      !same(
        win32.join(win32.resolve(launchHome, geminiDir), appDir),
        win32.resolve(hostHome, '.gemini', 'antigravity-cli')
      ) ||
      isAntigravityWindowsFileHost(env) !== isAntigravityWindowsFileHost(process.env)
    ) {
      throw new Error(
        'This agy launch uses a different credential authority from the selected Antigravity account.'
      )
    }
    await getAntigravityAccountService({ runtime: 'host' }).prepareForLaunch()
    return
  }
  const home = env.HOME ?? env.USERPROFILE
  if (
    args.envToDelete?.some((key) => ['HOME', 'USERPROFILE'].includes(key)) ||
    (home && resolve(home) !== resolve(getAppEnvironment().getPath('home'))) ||
    isAntigravityFileStorageHost(env) !== isAntigravityFileStorageHost(process.env)
  ) {
    throw new Error(
      'This agy launch uses a different credential authority from the selected Antigravity account.'
    )
  }
  await getAntigravityAccountService({ runtime: 'host' }).prepareForLaunch()
}
