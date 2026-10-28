import { basename, dirname, join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../shared/app-environment'

/** Keep this reachable from plain-Node entries; the build guard rejects Electron imports here. */
export type MainEntryLayout = {
  isPackaged: boolean
  /** Undefined on a non-Electron host: `process.resourcesPath` is Electron-only. */
  resourcesPath: string | undefined
  moduleDir: string
}

export function resolveMainEntryPath(layout: MainEntryLayout, entryFileName: string): string {
  // Plain-Node orcad can be packaged without Electron resources; its entries live beside the module.
  if (layout.isPackaged && layout.resourcesPath) {
    return join(layout.resourcesPath, 'app.asar', 'out', 'main', entryFileName)
  }
  return join(layout.moduleDir, entryFileName)
}

// The build's `chunkFileNames` folder; public entries sit one level up, beside main.
const SHARED_CHUNK_DIR_NAME = 'chunks'

export function currentMainEntryLayout(moduleDir: string): MainEntryLayout {
  return {
    isPackaged: hasAppEnvironment() && getAppEnvironment().isPackaged(),
    resourcesPath:
      'resourcesPath' in process && typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : undefined,
    // Why: a caller bundled into a shared chunk sees `out/main/chunks` as its `__dirname`.
    moduleDir: basename(moduleDir) === SHARED_CHUNK_DIR_NAME ? dirname(moduleDir) : moduleDir
  }
}
