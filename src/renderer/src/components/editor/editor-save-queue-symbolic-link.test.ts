import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as RuntimeFileMutation from '@/runtime/runtime-file-mutation-client'
import type { OpenFile } from '@/store/slices/editor'
import { createEditorSaveQueue, type EditorSaveQueue } from './editor-save-queue'
import { withEditorFileWriteLock } from './editor-file-write-lock'
import { editorPathHoldKey } from './editor-autosave-holds'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines,
  type FakeEditorDisk
} from './editor-autosave-controller-test-fixture'

const transport = vi.hoisted(() => ({ prepare: async () => {} }))
vi.mock('@/runtime/runtime-file-mutation-client', async (importOriginal) => {
  const original = await importOriginal<typeof RuntimeFileMutation>()
  return {
    ...original,
    writeRuntimeFile: async (...args: Parameters<typeof original.writeRuntimeFile>) => {
      await transport.prepare()
      return original.writeRuntimeFile(...args)
    }
  }
})

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

const PATH = '/repo/link.txt'
let disk: FakeEditorDisk
let store: ReturnType<typeof createEditorStore>
let queue: EditorSaveQueue
const diff: OpenFile = {
  id: 'diff',
  filePath: PATH,
  relativePath: 'link.txt',
  worktreeId: 'wt-1',
  language: 'plaintext',
  mode: 'diff',
  diffSource: 'unstaged',
  isDirty: true
}

beforeEach(() => {
  vi.useFakeTimers()
  transport.prepare = async () => {}
  disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [PATH]: 'target bytes' }))
  store = createEditorStore()
  store.setState({ openFiles: [diff], editorDrafts: { diff: 'preserved draft' } })
  withLoadedBaselines(store, disk)
  queue = createEditorSaveQueue(store)
})
afterEach(() => {
  queue.dispose()
  __clearSelfWriteRegistryForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['user', 'overwrite', 'autosave', 'restart', 'convert'] as const)(
  'refuses a queued %s after a current diff load identifies a link',
  async (trigger) => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = withEditorFileWriteLock(
      editorPathHoldKey(store.getState(), diff, PATH),
      () => gate
    )
    const save = queue.queueSave(diff, '/outside/target', trigger)
    await vi.advanceTimersByTimeAsync(0)
    expect(disk.fs.writeFile).not.toHaveBeenCalled()
    store.getState().setDiffSymbolicLink(diff.id, true)
    release()
    await held
    expect(await save).toBe('failed')
    expect(disk.files.get(PATH)).toBe('target bytes')
    expect(disk.fs.writeFile).not.toHaveBeenCalled()
    expect(store.getState().editorDrafts.diff).toBe('preserved draft')
    expect(store.getState().openFiles[0]?.isDirty).toBe(true)
  }
)

it('does not schedule autosave for a marked diff or erase its draft', async () => {
  store.getState().setDiffSymbolicLink(diff.id, true)
  queue.syncAutoSave()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(disk.files.get(PATH)).toBe('target bytes')
  expect(disk.fs.writeFile).not.toHaveBeenCalled()
  expect(store.getState().editorDrafts.diff).toBe('preserved draft')
})

it('allows an ordinary edit view of the same path to save target bytes independently', async () => {
  store.getState().setDiffSymbolicLink(diff.id, true)
  const editor: OpenFile = { ...diff, id: 'editor', mode: 'edit', symbolicLink: undefined }
  store.setState({ openFiles: [...store.getState().openFiles, editor] })
  withLoadedBaselines(store, disk)
  store.getState().setEditorDraft(editor.id, 'edited target bytes')
  expect(await queue.queueSave(editor, 'edited target bytes')).toBe('written')
  expect(disk.files.get(PATH)).toBe('edited target bytes')
  expect(store.getState().editorDrafts.diff).toBe('preserved draft')
})

it('refuses Overwrite when link classification arrives during transport preparation', async () => {
  let release = () => {}
  let started = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const preparing = new Promise<void>((resolve) => {
    started = resolve
  })
  transport.prepare = async () => {
    started()
    await gate
  }
  const save = queue.queueSave(diff, '/outside/target', 'overwrite')
  await preparing
  store.getState().setDiffSymbolicLink(diff.id, true)
  release()
  expect(await save).toBe('failed')
  expect(disk.files.get(PATH)).toBe('target bytes')
  expect(disk.fs.writeFile).not.toHaveBeenCalled()
  expect(store.getState().editorDrafts.diff).toBe('preserved draft')
})
