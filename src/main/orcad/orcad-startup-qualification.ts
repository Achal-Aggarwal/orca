// A slot qualified once on an unchanged host need not re-run the disposable startup preflight.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { ORCAD_NODE_RUNTIME_IDENTITY } from '../../shared/orcad-node-runtime-identity'
import { listOrcadArtifactFilenames } from './orcad-artifact-identity'
import { detectNativeHostAbi } from './native-host-abi'

export const ORCAD_STARTUP_QUALIFIED_FILENAME = '.orcad-startup-qualified'

/**
 * What the preflight's verdict depends on: the slot's code and installed bytes (stat identity,
 * so a replaced or rewritten file re-qualifies), the runtime, and the host's libc and kernel.
 */
export async function orcadStartupQualificationKey(
  directory: string,
  artifactVersion: string
): Promise<string> {
  const files = createHash('sha256')
  for (const filename of await listOrcadArtifactFilenames(directory)) {
    const { size, mtimeMs, ctimeMs, ino } = await stat(join(directory, filename))
    files.update(JSON.stringify([filename, size, mtimeMs, ctimeMs, ino]))
  }
  const abi = detectNativeHostAbi()
  return JSON.stringify({
    schema: 1,
    artifactVersion,
    runtime: ORCAD_NODE_RUNTIME_IDENTITY,
    node: process.versions.node,
    abi,
    kernel: release(),
    files: files.digest('hex')
  })
}

/**
 * True when the last launch with this key reached readiness. The marker is removed here, so a
 * launch that fails or crashes before readiness leaves the next one to re-qualify.
 */
export async function consumeOrcadStartupQualification(
  directory: string,
  key: string
): Promise<boolean> {
  const marker = join(directory, ORCAD_STARTUP_QUALIFIED_FILENAME)
  try {
    if ((await readFile(marker, 'utf8')) !== key) {
      return false
    }
    await unlink(marker)
    return true
  } catch {
    // Unreadable, unparsable or undeletable: qualify as before.
    return false
  }
}

/** Written only after readiness; temp + rename so a torn write never matches. Fails open. */
export async function recordOrcadStartupQualification(
  directory: string,
  key: string
): Promise<void> {
  const marker = join(directory, ORCAD_STARTUP_QUALIFIED_FILENAME)
  const temporary = `${marker}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, key, { mode: 0o600 })
    await rename(temporary, marker)
  } catch {
    await unlink(temporary).catch(() => {})
  }
}
