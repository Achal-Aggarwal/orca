import { createHash } from 'node:crypto'
import { mkdir, opendir, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  terminalTextInputSchema,
  type NativeChatTerminalTextInput,
  type NativeChatTerminalTextRetirement
} from '../../shared/native-chat-terminal-text-input'
import { assertClipboardTextWithinLimit } from '../../shared/clipboard-text'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { bestEffortFsyncDirectorySync } from '../../shared/secure-file'
import { writeTempFileDurable } from '../durable-file-write'

const recordSchema = terminalTextInputSchema.omit({ sources: true }).extend({
  fingerprint: z.string(),
  sourceIds: z.array(z.string().uuid()).min(1)
})

/** Pending directories are inventory; atomic directory publication transfers ownership to requested input. */
export class NativeChatTerminalTextInputs {
  private readonly active = new Map<
    string,
    { fingerprint: string; result: Promise<Record<string, string>> }
  >()
  private maintenance: Promise<void> | null = null
  constructor(private readonly root: string) {}

  private directory(area: 'pending' | 'published', id: string): string {
    return join(this.root, area, id)
  }
  private async initialize(): Promise<void> {
    await mkdir(join(this.root, 'pending'), { recursive: true })
    await mkdir(join(this.root, 'published'), { recursive: true })
    for (const folder of [
      dirname(dirname(this.root)),
      dirname(this.root),
      this.root,
      join(this.root, 'pending'),
      join(this.root, 'published')
    ]) {
      bestEffortFsyncDirectorySync(folder)
    }
  }
  private async record(directory: string) {
    return recordSchema.parse(JSON.parse(await readFile(join(directory, 'input.json'), 'utf8')))
  }
  private paths(input: { requestId: string; sourceIds: string[] }): Record<string, string> {
    return Object.fromEntries(
      input.sourceIds.map((id) => [
        id,
        join(this.directory('published', input.requestId), `${id}.txt`)
      ])
    )
  }

  materialize(value: NativeChatTerminalTextInput): Promise<Record<string, string>> {
    const input = terminalTextInputSchema.parse(value)
    if (new Set(input.sources.map((source) => source.id)).size !== input.sources.length) {
      throw new Error('Duplicate paste identity.')
    }
    for (const source of input.sources) {
      assertClipboardTextWithinLimit(source.text)
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const active = this.active.get(input.requestId)
    if (active) {
      if (active.fingerprint !== fingerprint) {
        return Promise.reject(new Error('Input request identity changed.'))
      }
      return active.result
    }
    const result = this.prepare(input, fingerprint).finally(() =>
      this.active.delete(input.requestId)
    )
    this.active.set(input.requestId, { fingerprint, result })
    return result
  }
  private async prepare(
    input: NativeChatTerminalTextInput,
    fingerprint: string
  ): Promise<Record<string, string>> {
    await this.initialize()
    const published = this.directory('published', input.requestId)
    try {
      const existing = await this.record(published)
      if (existing.fingerprint !== fingerprint) {
        throw new Error('Input request identity changed.')
      }
      return this.paths(existing)
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
    }
    const pending = this.directory('pending', input.requestId)
    await mkdir(pending)
    bestEffortFsyncDirectorySync(dirname(pending))
    const { sources, ...submitted } = input
    const record = { ...submitted, fingerprint, sourceIds: sources.map((source) => source.id) }
    await writeTempFileDurable(join(pending, 'input.part'), JSON.stringify(record), 0o600)
    await rename(join(pending, 'input.part'), join(pending, 'input.json'))
    bestEffortFsyncDirectorySync(pending)
    for (const { id, text } of sources) {
      await writeTempFileDurable(join(pending, `${id}.part`), text, 0o600)
      await rename(join(pending, `${id}.part`), join(pending, `${id}.txt`))
    }
    bestEffortFsyncDirectorySync(pending)
    await rename(pending, published)
    bestEffortFsyncDirectorySync(dirname(published))
    bestEffortFsyncDirectorySync(dirname(pending))
    return this.paths(record)
  }

  /** Only the caller's proof of no handoff may retire a requested input. A lost reply keeps it. */
  async retire(input: NativeChatTerminalTextRetirement): Promise<void> {
    const { requestId } = terminalTextInputSchema
      .pick({ requestId: true, scopeKey: true, ptyId: true })
      .parse(input)
    if (this.active.has(requestId)) {
      throw new Error('Input preparation is still active.')
    }
    const published = this.directory('published', requestId)
    try {
      const record = await this.record(published)
      if (record.scopeKey !== input.scopeKey || record.ptyId !== input.ptyId) {
        throw new Error('Input owner changed.')
      }
      await rename(published, this.directory('pending', requestId))
      bestEffortFsyncDirectorySync(dirname(published))
      bestEffortFsyncDirectorySync(join(this.root, 'pending'))
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
    }
  }

  sweep(): Promise<void> {
    this.maintenance ??= this.collect().finally(() => {
      this.maintenance = null
    })
    return this.maintenance
  }
  private async collect(): Promise<void> {
    let entries
    try {
      entries = await opendir(join(this.root, 'pending'))
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return
      }
      throw error
    }
    let count = 0
    for await (const entry of entries) {
      if (
        !z.string().uuid().safeParse(entry.name).success ||
        !entry.isDirectory() ||
        this.active.has(entry.name)
      ) {
        continue
      }
      const pending = this.directory('pending', entry.name)
      try {
        let ids: string[] = []
        try {
          ids = (await this.record(pending)).sourceIds
        } catch (error) {
          if (!isDefinitiveAbsence(error)) {
            throw error
          }
        }
        for (const id of ids) {
          for (const extension of ['part', 'txt']) {
            await this.remove(join(pending, `${id}.${extension}`))
          }
        }
        await this.remove(join(pending, 'input.part'))
        bestEffortFsyncDirectorySync(pending)
        await this.remove(join(pending, 'input.json'))
        await rmdir(pending)
        bestEffortFsyncDirectorySync(dirname(pending))
      } catch {
        /* Keep unreadable authority and failed deletions for the next maintenance wake. */
      }
      if (++count % 32 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }
  private async remove(path: string): Promise<void> {
    try {
      await unlink(path)
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
    }
  }
}

let owner: NativeChatTerminalTextInputs | null = null
let maintenanceTimer: ReturnType<typeof setInterval> | null = null

export function terminalTextInputs(root: string): NativeChatTerminalTextInputs {
  owner ??= new NativeChatTerminalTextInputs(root)
  return owner
}
export function startTerminalTextInputMaintenance(
  resolve: () => NativeChatTerminalTextInputs
): void {
  if (maintenanceTimer) {
    return
  }
  const sweep = () => {
    void Promise.resolve()
      .then(() => resolve().sweep())
      .catch(() => {})
  }
  sweep()
  maintenanceTimer = setInterval(sweep, 6 * 60 * 60 * 1000)
  maintenanceTimer.unref?.()
}
export function stopTerminalTextInputMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer)
  }
  maintenanceTimer = null
}
