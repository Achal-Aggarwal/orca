import { readFile, lstat, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { asRecord } from '../ai-vault/session-scanner-record-value'
import type { OpenCodeSessionPresence, OpenCodeSessionSource } from './opencode-session-presence'

async function readJson(path: string) {
  try {
    const value = asRecord(JSON.parse(await readFile(path, 'utf8')))
    if (!value) {
      throw new Error('Unknown source')
    }
    return value
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') {
      for (let probe = path; ; probe = dirname(probe)) {
        try {
          const entry = await lstat(probe)
          if (entry.isSymbolicLink()) {
            await stat(probe).catch(() => {
              throw new Error('Unreachable source')
            })
          }
          return undefined
        } catch (missing) {
          if (asRecord(missing)?.code !== 'ENOENT') {
            throw missing
          }
          if (probe === dirname(probe)) {
            return undefined
          }
        }
      }
    }
    throw error
  }
}

function roots(env: NodeJS.ProcessEnv, cwd: string) {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
  if (!isAbsolute(home)) {
    throw new Error('Unknown home')
  }
  return {
    data: resolve(cwd, env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode'),
    state: resolve(cwd, env.XDG_STATE_HOME || join(home, '.local', 'state'), 'opencode'),
    config: env.OPENCODE_CONFIG_DIR
      ? resolve(cwd, env.OPENCODE_CONFIG_DIR)
      : resolve(cwd, env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
  }
}

async function serviceConfig(path: string, knownSavedState: boolean) {
  const config = await readJson(join(path, 'service.json'))
  if (config?.disabled !== undefined && typeof config.disabled !== 'boolean') {
    throw new Error('Unknown service configuration')
  }
  const env = asRecord(config?.env)
  if (
    config?.env !== undefined &&
    (!env || Object.values(env).some((value) => typeof value !== 'string'))
  ) {
    throw new Error('Unknown service environment')
  }
  if (!knownSavedState && env?.XDG_STATE_HOME !== undefined) {
    throw new Error('Unknown service environment dialect')
  }
  return {
    disabled: config?.disabled === true,
    env: Object.fromEntries(
      Object.entries(env ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  }
}

async function servicePresence(
  file: string,
  version: string,
  id: string,
  signal: AbortSignal
): Promise<OpenCodeSessionPresence | null> {
  const info = await readJson(file)
  if (!info) {
    return null
  }
  if (typeof info.pid !== 'number' || !Number.isInteger(info.pid) || info.pid <= 0) {
    return 'unavailable'
  }
  try {
    process.kill(info.pid, 0)
  } catch (error) {
    return asRecord(error)?.code === 'ESRCH' ? null : 'unavailable'
  }
  if (
    info.version !== version ||
    typeof info.url !== 'string' ||
    (info.password !== undefined && typeof info.password !== 'string')
  ) {
    return 'unavailable'
  }
  const url = new URL(info.url)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    return 'unavailable'
  }
  const headers =
    typeof info.password === 'string'
      ? { authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString('base64')}` }
      : undefined
  const get = (path: string) => fetch(new URL(path, url), { headers, signal, redirect: 'error' })
  let health = await get('/api/info')
  if (health.status === 404) {
    health = await get('/api/health')
  }
  const identity = asRecord(await health.json())
  if (!health.ok || identity?.pid !== info.pid || identity.version !== info.version) {
    return 'unavailable'
  }
  const response = await get(`/api/session/${encodeURIComponent(id)}`)
  const body = asRecord(await response.json())
  const after = await readJson(file)
  if (
    !after ||
    ['id', 'pid', 'version', 'url', 'password'].some((key) => info[key] !== after[key])
  ) {
    return 'unavailable'
  }
  if (response.ok && asRecord(body?.data)?.id === id) {
    return 'present'
  }
  return response.status === 404 && body?._tag === 'SessionNotFoundError' && body.sessionID === id
    ? 'absent'
    : 'unavailable'
}

/** Select one authority; failed service reads never fall through to another store. */
export async function resolveOpenCodeSessionSource(args: {
  env: NodeJS.ProcessEnv
  cwd: string
  version: string
  api: 'v1' | 'v2'
  standalone: boolean
  sessionId: string
  signal: AbortSignal
}): Promise<OpenCodeSessionSource | OpenCodeSessionPresence> {
  const version = /^(1|2)\.(\d+)\.(\d+)$/.exec(args.version)
  if (!version || `v${version[1]}` !== args.api) {
    return 'unavailable'
  }
  const minor = Number(version[2]),
    patch = Number(version[3])
  const legacy = args.api === 'v1' && minor < 2
  const customDb = args.api === 'v2' || minor >= 3
  // The exact state-filter transition after 2.1.3 is unpinned; only affected configs are unknown.
  const knownSavedState = minor === 0 || (minor === 1 && patch <= 3)
  let env = args.env
  let paths = roots(env, args.cwd)
  if (args.api === 'v2' && !args.standalone) {
    const config = await serviceConfig(paths.config, knownSavedState)
    if (!config.disabled) {
      const present = await servicePresence(
        join(paths.state, 'service.json'),
        args.version,
        args.sessionId,
        args.signal
      )
      if (present !== null) {
        return present
      }
      env = { ...env, ...config.env }
      paths = roots(env, args.cwd)
      if (minor > 0 || patch >= 31) {
        const serverConfig = await serviceConfig(paths.config, knownSavedState)
        // Global roots are fixed before the server's second saved-env application.
        env = { ...env, ...serverConfig.env }
      }
    }
  }
  if (legacy) {
    return { root: paths.data, cwd: args.cwd, env, api: 'v1', storage: 'legacy' }
  }
  if (args.api === 'v1' && minor === 2 && patch > 27 && env.OPENCODE_DB) {
    return 'unavailable'
  }
  // Stable release builds use the canonical channel; unpinned preview/custom dialects stay unknown.
  const selection = customDb
    ? args.api === 'v2'
      ? (env.OPENCODE_DB ?? 'opencode.db')
      : env.OPENCODE_DB || 'opencode.db'
    : 'opencode.db'
  if (selection === '' || selection === ':memory:') {
    return 'unavailable'
  }
  return {
    root: paths.data,
    dbPath: resolve(paths.data, selection),
    api: args.api,
    storage: 'sqlite'
  }
}
