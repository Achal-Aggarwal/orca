import { createReadStream } from 'node:fs'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createZstdDecompress, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as values from '../../ai-vault/session-scanner-values'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  prepareLegacyTranscriptImport,
  importLegacyTranscriptIntoJournal
} from './journal-legacy-import'
import { openAgentSessionJournal } from './journal-store-factory'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import {
  writeCodexHistoryFixture,
  type CodexHistoryPositionFixture
} from './codex-history-test-fixture'

vi.mock(import('node:fs'), async (original) => {
  const fs = await original()
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) }
})
vi.mock(import('node:fs/promises'), async (original) => {
  const fs = await original()
  return { ...fs, readdir: vi.fn(fs.readdir) }
})
vi.mock(import('node:zlib'), async (original) => {
  const zlib = await original()
  return { ...zlib, createZstdDecompress: vi.fn(zlib.createZstdDecompress) }
})

const PARENT = '01a17c7f-6f58-7a73-b87a-a8702ff2da17'
const CHILD = '01a17c81-30d1-72f0-b84e-002ddfe6fd47'
const MIDDLE = '01a17c80-30d1-72f0-b84e-002ddfe6fd47'
let root: string
const journals = createTrackedJournalOpener()
beforeEach(async () => {
  const account = await mkdtemp(join(tmpdir(), 'orca-codex-lineage-'))
  root = join(account, 'sessions')
  await mkdir(root)
  await mkdir(join(account, 'archived_sessions'))
})
afterEach(async () => {
  await journals.closeAll()
  await rm(dirname(root), { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

async function journal() {
  return journals.track(
    await openAgentSessionJournal({
      identity: {
        sessionId: CHILD,
        agent: 'codex',
        hostId: 'host',
        workspaceId: 'workspace',
        providerHandle: codexProviderHandle(CHILD)
      },
      database: openTestJournalHostDatabase(root)
    })
  )
}
function request(filePath: string) {
  return {
    agent: 'codex' as const,
    sessionId: CHILD,
    options: {
      filePath,
      codexSessionsDirs: [root],
      source: { providerSessionId: CHILD, workspaceCwd: '/workspace' }
    }
  }
}

it('imports canonical completed items once with stable nested IDs, including repeated prompts', async () => {
  const fixture = await writeCodexHistoryFixture(
    root,
    CHILD,
    ['ice', 'ice'],
    undefined,
    CHILD,
    true
  )
  const input = request(fixture.filePath)
  const first = await prepareLegacyTranscriptImport(input)
  expect(first.ok && first.items.map((item) => item.identity)).toMatchObject([
    { recordId: `${CHILD}:user-0` },
    { recordId: `${CHILD}:reason` },
    { recordId: `${CHILD}:answer-0` },
    { recordId: `${CHILD}:user-1` },
    { recordId: `${CHILD}:answer-1` }
  ])
  expect(await prepareLegacyTranscriptImport(input)).toEqual(first)
  const destination = await journal()
  expect(
    await importLegacyTranscriptIntoJournal({ ...input, journal: destination, fence: 1 })
  ).toMatchObject({ ok: true, imported: 5 })
  const rows = destination.snapshot().items
  expect(rows.map((item) => item.body)).toMatchObject([
    { role: 'user', blocks: [{ text: 'ice' }] },
    { role: 'reasoning', blocks: [{ text: 'why' }] },
    { role: 'assistant', blocks: [{ text: 'ice answer' }] },
    { role: 'user', blocks: [{ text: 'ice' }] },
    { role: 'assistant', blocks: [{ text: 'ice answer' }] }
  ])
  await importLegacyTranscriptIntoJournal({ ...input, journal: destination, fence: 1 })
  expect(destination.snapshot().items.map((item) => [item.itemId, item.body])).toEqual(
    rows.map((item) => [item.itemId, item.body])
  )
  await writeFile(
    fixture.filePath,
    JSON.stringify({
      type: 'message',
      id: 'early',
      role: 'user',
      content: [{ type: 'input_text', text: 'early format' }]
    })
  )
  const legacy = await prepareLegacyTranscriptImport({
    ...input,
    options: { filePath: fixture.filePath }
  })
  expect(legacy.ok && legacy.items.map((item) => item.body)).toMatchObject([
    { role: 'user', blocks: [{ text: 'early format' }] }
  ])
})

it.each([
  ['user', 'input_text'],
  ['assistant', 'output_text']
] as const)('imports wrapped raw-only %s messages', async (role, type) => {
  const filePath = join(root, 'rollout.jsonl')
  await writeFile(
    filePath,
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type, text: 'Raw-only message' }] }
    })
  )
  const result = await prepareLegacyTranscriptImport({
    agent: 'codex',
    sessionId: CHILD,
    options: { filePath }
  })
  expect(result.ok && result.items.map((item) => item.body)).toMatchObject([
    { role, blocks: [{ type: 'text', text: 'Raw-only message' }] }
  ])
})

it.each(['active', 'archive', 'compressed'] as const)(
  'reads %s prefixes oldest first, excludes later turns and leaves copied forks standalone',
  async (location) => {
    const parent = await writeCodexHistoryFixture(root, PARENT, ['sky'], undefined, MIDDLE)
    const middle = await writeCodexHistoryFixture(root, MIDDLE, ['leaves'], parent.position)
    const child = await writeCodexHistoryFixture(root, CHILD, ['ice'], middle.position)
    const later = await writeCodexHistoryFixture(root, '01a17c82-30d1-72f0-b84e-002ddfe6fd47', [
      'S1'
    ])
    await appendFile(
      parent.filePath,
      `${later.records
        .slice(1)
        .map((record, index) =>
          JSON.stringify({ ...record, ordinal: parent.position.end_ordinal_exclusive + index })
        )
        .join('\n')}\n`
    )
    if (location !== 'active') {
      const archived = join(dirname(root), 'archived_sessions', basename(parent.filePath))
      if (location === 'compressed') {
        await writeFile(`${archived}.zst`, zstdCompressSync(await readFile(parent.filePath)))
        await rm(parent.filePath)
      } else {
        await rename(parent.filePath, archived)
      }
    }
    const result = await prepareLegacyTranscriptImport(request(child.filePath))
    expect(result.ok && result.items.map((item) => item.body)).toMatchObject([
      { blocks: [{ text: 'sky' }] },
      { blocks: [{ text: 'sky answer' }] },
      { blocks: [{ text: 'leaves' }] },
      { blocks: [{ text: 'leaves answer' }] },
      { blocks: [{ text: 'ice' }] },
      { blocks: [{ text: 'ice answer' }] }
    ])
    const copy = await writeCodexHistoryFixture(root, CHILD, ['ice'])
    await writeFile(
      copy.filePath,
      copy.records
        .map((record, index) =>
          JSON.stringify(
            index === 0
              ? {
                  ...record,
                  payload: {
                    ...record.payload,
                    forked_from_id: PARENT,
                    forked_from_ordinal_exclusive: 28
                  }
                }
              : record
          )
        )
        .join('\n')
    )
    const copied = await prepareLegacyTranscriptImport(request(copy.filePath))
    expect(copied.ok && copied.items).toHaveLength(2)
    expect(createZstdDecompress).toHaveBeenCalledTimes(location === 'compressed' ? 2 : 0)
    expect(
      vi.mocked(createReadStream).mock.results.every(({ value }) => value.destroyed && value.closed)
    ).toBe(true)
    expect(
      vi
        .mocked(createZstdDecompress)
        .mock.results.every(({ value }) => value.destroyed && value.closed)
    ).toBe(true)
  }
)

it.each(['missing', 'cycle', 'wrong-store', 'ordinal', 'byte', 'truncated'] as const)(
  'refuses %s ancestry without changing a journal',
  async (fault) => {
    const outside = join(root, 'other-account')
    await mkdir(outside)
    const selectedStore = join(root, 'selected-account')
    await mkdir(selectedStore)
    const parent = await writeCodexHistoryFixture(
      fault === 'wrong-store' ? outside : selectedStore,
      PARENT,
      ['sky']
    )
    const position = { ...parent.position }
    if (fault === 'missing') {
      await rm(parent.filePath)
    }
    if (fault === 'cycle') {
      position.thread_id = CHILD
    }
    if (fault === 'ordinal') {
      position.end_ordinal_exclusive += 1
    }
    if (fault === 'byte') {
      position.end_byte_offset -= 1
    }
    if (fault === 'truncated') {
      position.end_byte_offset += 1
    }
    const child = await writeCodexHistoryFixture(selectedStore, CHILD, ['ice'], position)
    const destination = await journal()
    const before = destination.snapshot()
    const result = await importLegacyTranscriptIntoJournal({
      ...request(child.filePath),
      options: { filePath: child.filePath, codexSessionsDirs: [selectedStore] },
      journal: destination,
      fence: 1
    })
    expect(result).toMatchObject({ ok: false })
    expect(destination.snapshot()).toEqual(before)
    expect(
      vi.mocked(createReadStream).mock.results.every(({ value }) => value.destroyed && value.closed)
    ).toBe(true)
  }
)

it('uses a readable active parent without consulting an inaccessible archive', async () => {
  const parent = await writeCodexHistoryFixture(root, PARENT, ['sky'])
  const child = await writeCodexHistoryFixture(root, CHILD, ['ice'], parent.position)
  const archive = join(dirname(root), 'archived_sessions')
  const fs = await vi.importActual<typeof FsPromises>('node:fs/promises')
  vi.mocked(readdir).mockImplementation((...args) => {
    if (args[0] === archive) {
      throw Object.assign(new Error('Archive is inaccessible.'), { code: 'EACCES' })
    }
    return fs.readdir(...args)
  })
  try {
    const result = await prepareLegacyTranscriptImport(request(child.filePath))
    expect(result.ok && result.items.map((item) => item.body)).toMatchObject([
      { blocks: [{ text: 'sky' }] },
      { blocks: [{ text: 'sky answer' }] },
      { blocks: [{ text: 'ice' }] },
      { blocks: [{ text: 'ice answer' }] }
    ])
    expect(readdir).toHaveBeenCalledTimes(1)
    expect(vi.mocked(readdir).mock.calls.some(([path]) => path === archive)).toBe(false)
    await rename(parent.filePath, join(archive, basename(parent.filePath)))
    const destination = await journal()
    const before = destination.snapshot()
    expect(
      await importLegacyTranscriptIntoJournal({
        ...request(child.filePath),
        journal: destination,
        fence: 1
      })
    ).toMatchObject({ ok: false })
    expect(vi.mocked(readdir).mock.calls.some(([path]) => path === archive)).toBe(true)
    expect(destination.snapshot()).toEqual(before)
    expect(
      vi.mocked(createReadStream).mock.results.every(({ value }) => value.destroyed && value.closed)
    ).toBe(true)
  } finally {
    vi.mocked(readdir).mockImplementation(fs.readdir)
  }
})

it.each([100, 1000])(
  'prepares %i account entries/turns once through a deep lineage with linear work',
  async (count) => {
    let base: CodexHistoryPositionFixture | undefined
    for (let index = 0; index < 40; index++) {
      const id = `01a17c7f-6f58-7a73-b87a-${String(index).padStart(12, '0')}`
      const segment = await writeCodexHistoryFixture(root, id, [String(index)], base)
      base = segment.position
      if (count === 1000 && index === 0) {
        await rename(
          segment.filePath,
          join(dirname(root), 'archived_sessions', basename(segment.filePath))
        )
      }
    }
    const child = await writeCodexHistoryFixture(
      root,
      CHILD,
      Array.from({ length: count }, (_, i) => `turn-${i}`),
      base
    )
    for (let index = 0; index < count; index++) {
      await writeFile(join(root, `unrelated-${index}.jsonl`), '')
    }
    const parses = vi.spyOn(values, 'parseJsonObject')
    const result = await prepareLegacyTranscriptImport(request(child.filePath))
    expect(result.ok && result.items).toHaveLength(2 * (40 + count))
    expect(result.ok && result.items[0]?.body).toMatchObject({ blocks: [{ text: '0' }] })
    expect(result.ok && result.items.at(-1)?.body).toMatchObject({
      blocks: [{ text: `turn-${count - 1} answer` }]
    })
    expect(readdir).toHaveBeenCalledTimes(count === 1000 ? 2 : 1)
    const listings = await Promise.all(vi.mocked(readdir).mock.results.map(({ value }) => value))
    expect(listings.reduce((total, entries) => total + entries.length, 0)).toBe(count + 41)
    expect(parses.mock.calls.length).toBeLessThanOrEqual(10 * count + 500)
    expect(createReadStream).toHaveBeenCalledTimes(82)
    expect(
      vi.mocked(createReadStream).mock.results.every(({ value }) => value.destroyed && value.closed)
    ).toBe(true)
  }
)
