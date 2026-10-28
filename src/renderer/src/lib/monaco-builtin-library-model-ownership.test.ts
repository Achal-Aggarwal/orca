import { afterEach, expect, it, vi } from 'vitest'
import { Uri, type editor } from 'monaco-editor'
import { libFileSet } from 'monaco-editor/esm/vs/language/typescript/lib/lib.index.js'
import { installMonacoBuiltinLibraryModelOwnership } from './monaco-builtin-library-model-ownership'

vi.mock('monaco-editor', async () => {
  const { URI } = await import('monaco-editor/esm/vs/base/common/uri.js')
  return { Uri: URI }
})

function event<T>() {
  const listeners = new Set<(value: T) => void>()
  return {
    subscribe: (listener: (value: T) => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire: (value: T) => {
      for (const listener of listeners) {
        listener(value)
      }
    },
    size: () => listeners.size
  }
}

const stops: (() => void)[] = []
const DOM = 'file:///lib.dom.d.ts'

function fixture() {
  const models = new Map<string, ReturnType<typeof makeModel>>()
  const created = event<ReturnType<typeof makeModel>>()
  const removing = event<ReturnType<typeof makeModel>>()
  const languageChanged = event<{ model: ReturnType<typeof makeModel>; oldLanguage: string }>()
  const openChanged = event<void>()
  const openSources = new Set<string>()
  function makeModel(uri: Uri, language = 'typescript') {
    let version = 1
    let disposed = false
    let attached = false
    const content = event<editor.IModelContentChangedEvent>()
    const attachment = event<void>()
    const model = {
      uri,
      getLanguageId: () => language,
      getVersionId: () => version,
      isDisposed: () => disposed,
      isAttachedToEditor: () => attached,
      onDidChangeContent: content.subscribe,
      onDidChangeAttached: attachment.subscribe,
      setAttached: (value: boolean) => {
        attached = value
        attachment.fire()
      },
      edit: () => {
        version += 1
        content.fire({
          changes: [],
          eol: '\n',
          versionId: version,
          isUndoing: false,
          isRedoing: false,
          isFlush: false,
          isEolChange: false,
          detailedReasonsChangeLengths: []
        })
      },
      setLanguage: (value: string) => {
        const oldLanguage = language
        language = value
        languageChanged.fire({ model, oldLanguage })
      },
      dispose: () => {
        removing.fire(model)
        models.delete(uri.toString())
        disposed = true
      },
      listenerCount: () => content.size() + attachment.size()
    }
    models.set(uri.toString(), model)
    created.fire(model)
    return model
  }
  class LibraryFiles {
    _hasFetchedLibFiles = true
    getOrCreateModel(fileName: string) {
      return models.get(fileName) ?? makeModel(Uri.parse(fileName))
    }
  }
  const originalCreate = LibraryFiles.prototype.getOrCreateModel
  const referenceDisposed = vi.fn()
  const service = {
    createModelReference: vi.fn(async (_uri: Uri) => ({ object: {}, dispose: referenceDisposed }))
  }
  const originalReference = service.createModelReference
  const getReferenceService = vi.fn(() => service)
  const stop = installMonacoBuiltinLibraryModelOwnership(
    {
      Uri,
      editor: {
        getModel: (uri) => models.get(uri.toString()) ?? null,
        getModels: () => [...models.values()],
        onDidCreateModel: created.subscribe,
        onWillDisposeModel: removing.subscribe,
        onDidChangeModelLanguage: languageChanged.subscribe
      }
    },
    {
      factory: LibraryFiles.prototype,
      libFileSet,
      getReferenceService,
      isOpenSourceUri: (uri) => openSources.has(uri),
      subscribeOpenSources: (listener) => {
        const subscription = openChanged.subscribe(listener)
        return () => subscription.dispose()
      },
      delayMs: 1000
    }
  )
  stops.push(stop)
  return {
    models,
    makeModel,
    libraries: new LibraryFiles(),
    LibraryFiles,
    service,
    getReferenceService,
    referenceDisposed,
    originalCreate,
    originalReference,
    openSources,
    openChanged,
    stop,
    listeners: () => created.size() + removing.size() + languageChanged.size() + openChanged.size()
  }
}

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop()
  }
  vi.useRealTimers()
})

it('releases newly created standard libraries only after the final user script leaves', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const ts = f.makeModel(Uri.file('/project/source.ts'))
  const js = f.makeModel(Uri.file('/project/source.js'), 'javascript')
  const library = f.libraries.getOrCreateModel(DOM)
  ts.dispose()
  await vi.advanceTimersByTimeAsync(2000)
  expect(library.isDisposed()).toBe(false)
  js.setLanguage('plaintext')
  await vi.advanceTimersByTimeAsync(999)
  expect(library.isDisposed()).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(library.isDisposed()).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  expect(f.libraries.getOrCreateModel(DOM)).not.toBe(library)
})

it('never adopts a user root file or an extra-library model', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const user = f.makeModel(Uri.parse(DOM))
  expect(f.libraries.getOrCreateModel(DOM)).toBe(user)
  user.dispose()
  f.libraries._hasFetchedLibFiles = false
  const extra = f.libraries.getOrCreateModel(DOM)
  await vi.advanceTimersByTimeAsync(2000)
  expect(extra.isDisposed()).toBe(false)
  expect(f.getReferenceService).not.toHaveBeenCalled()
})

it('rejects catalog-like names with a different root, scheme, authority, query or fragment', async () => {
  vi.useFakeTimers()
  const f = fixture()
  for (const uri of [
    'file:///repo/lib.dom.d.ts',
    'file:///lib.user.d.ts',
    'untitled:/lib.dom.d.ts',
    'file://server/lib.dom.d.ts',
    `${DOM}?owner=x`,
    `${DOM}#selection`
  ]) {
    const model = f.libraries.getOrCreateModel(uri)
    await vi.advanceTimersByTimeAsync(1000)
    expect(model.isDisposed()).toBe(false)
    model.dispose()
  }
  expect(f.getReferenceService).not.toHaveBeenCalled()
})

it('protects a late unattached model reference until its final idempotent release', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const library = f.libraries.getOrCreateModel(DOM)
  const reference = await f.service.createModelReference(Uri.parse(DOM))
  f.referenceDisposed.mockImplementation(() => reference.dispose())
  await vi.advanceTimersByTimeAsync(2000)
  expect(library.isAttachedToEditor()).toBe(false)
  expect(library.isDisposed()).toBe(false)
  reference.dispose()
  reference.dispose()
  expect(f.referenceDisposed).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(library.isDisposed()).toBe(true)
})

it('protects attached readers and matching source tabs without polling them', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const library = f.libraries.getOrCreateModel(DOM)
  library.setAttached(true)
  await vi.advanceTimersByTimeAsync(2000)
  expect(library.isDisposed()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  f.openSources.add(DOM)
  library.setAttached(false)
  await vi.advanceTimersByTimeAsync(2000)
  expect(library.isDisposed()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  f.openSources.clear()
  f.openChanged.fire()
  await vi.advanceTimersByTimeAsync(1000)
  expect(library.isDisposed()).toBe(true)
})

it('retains pending reference acquisitions and releases rejected acquisitions', async () => {
  vi.useFakeTimers()
  const f = fixture()
  let complete = (): void => {}
  f.originalReference.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = () => resolve({ object: {}, dispose: f.referenceDisposed })
      })
  )
  const library = f.libraries.getOrCreateModel(DOM)
  const pending = f.service.createModelReference(Uri.parse(DOM))
  await vi.advanceTimersByTimeAsync(2000)
  expect(library.isDisposed()).toBe(false)
  complete()
  const reference = await pending
  reference.dispose()
  await vi.advanceTimersByTimeAsync(1000)
  expect(library.isDisposed()).toBe(true)
  const failed = f.libraries.getOrCreateModel(DOM)
  f.originalReference.mockRejectedValueOnce(new Error('reference failed'))
  await expect(f.service.createModelReference(Uri.parse(DOM))).rejects.toThrow('reference failed')
  await vi.advanceTimersByTimeAsync(1000)
  expect(failed.isDisposed()).toBe(true)
})

it('relinquishes ownership on edits and cancels idle cleanup when a source reopens', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const edited = f.libraries.getOrCreateModel(DOM)
  edited.edit()
  expect(edited.listenerCount()).toBe(0)
  const other = f.libraries.getOrCreateModel('file:///lib.es5.d.ts')
  await vi.advanceTimersByTimeAsync(2000)
  expect(edited.isDisposed()).toBe(false)
  expect(other.isDisposed()).toBe(false)
  edited.dispose()
  await vi.advanceTimersByTimeAsync(500)
  const successor = f.makeModel(Uri.file('/project/successor.ts'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(other.isDisposed()).toBe(false)
  successor.dispose()
  await vi.advanceTimersByTimeAsync(1000)
  expect(other.isDisposed()).toBe(true)
})

it('restores the factories and releases timers and listeners on teardown', () => {
  vi.useFakeTimers()
  const f = fixture()
  const library = f.libraries.getOrCreateModel(DOM)
  f.stop()
  expect(f.LibraryFiles.prototype.getOrCreateModel).toBe(f.originalCreate)
  expect(f.service.createModelReference).toBe(f.originalReference)
  expect(f.listeners()).toBe(0)
  expect(library.listenerCount()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(library.isDisposed()).toBe(false)
})
