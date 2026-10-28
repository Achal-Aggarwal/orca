import type { editor, Uri } from 'monaco-editor'

type Model = Pick<
  editor.ITextModel,
  | 'uri'
  | 'getLanguageId'
  | 'getVersionId'
  | 'isDisposed'
  | 'isAttachedToEditor'
  | 'onDidChangeAttached'
  | 'onDidChangeContent'
  | 'dispose'
>
type Disposable = { dispose(): void }
type Event<T> = (listener: (event: T) => void) => Disposable
type LibraryFactory = {
  _hasFetchedLibFiles?: boolean
  getOrCreateModel(fileName: string): Model | null
}
type ModelReference = { object: unknown; dispose(): void }
export type BuiltinLibraryReferenceService = {
  createModelReference(uri: Uri): Promise<ModelReference>
}
type Host = {
  Uri: { parse(value: string): Uri }
  editor: {
    getModel(uri: Uri): Model | null
    getModels(): readonly Model[]
    onDidCreateModel: Event<Model>
    onWillDisposeModel: Event<Model>
    onDidChangeModelLanguage: Event<{ model: Model; oldLanguage: string }>
  }
}
type Entry = { version: number; references: number; subscriptions: Disposable[] }
type Options = {
  factory: LibraryFactory
  libFileSet: Readonly<Record<string, boolean>>
  getReferenceService(): BuiltinLibraryReferenceService
  isOpenSourceUri(uri: string): boolean
  subscribeOpenSources(listener: () => void): () => void
  delayMs: number
}

const installed = new WeakSet<LibraryFactory>()
const isScript = (language: string): boolean =>
  language === 'typescript' || language === 'javascript'

export function installMonacoBuiltinLibraryModelOwnership(
  host: Host,
  options: Options
): () => void {
  const { factory } = options
  if (installed.has(factory) || typeof factory.getOrCreateModel !== 'function') {
    return () => {}
  }
  installed.add(factory)
  const owned = new Map<Model, Entry>()
  const originalCreate = factory.getOrCreateModel
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let pendingReconcile = false
  let restoreReferences: (() => void) | undefined

  const cancelTimer = (): void => {
    clearTimeout(timer)
    timer = undefined
  }
  const hasUserSources = (): boolean =>
    host.editor.getModels().some((model) => isScript(model.getLanguageId()) && !owned.has(model))
  const canRelease = (model: Model, entry: Entry): boolean =>
    !model.isDisposed() &&
    entry.references === 0 &&
    !model.isAttachedToEditor() &&
    model.getVersionId() === entry.version &&
    !options.isOpenSourceUri(model.uri.toString())
  const reconcile = (): void => {
    if (
      disposed ||
      owned.size === 0 ||
      hasUserSources() ||
      ![...owned].some(([model, entry]) => canRelease(model, entry))
    ) {
      cancelTimer()
      return
    }
    timer ??= setTimeout(() => {
      timer = undefined
      for (const [model, entry] of owned) {
        if (hasUserSources()) {
          break
        }
        if (canRelease(model, entry)) {
          model.dispose()
        }
      }
      reconcile()
    }, options.delayMs)
  }
  const reconcileAfterDisposal = (): void => {
    if (!pendingReconcile) {
      pendingReconcile = true
      queueMicrotask(() => {
        pendingReconcile = false
        reconcile()
      })
    }
  }
  const forget = (model: Model): void => {
    const entry = owned.get(model)
    owned.delete(model)
    for (const subscription of entry?.subscriptions ?? []) {
      subscription.dispose()
    }
    if (owned.size === 0) {
      cancelTimer()
    }
  }
  const retainReferences = (): boolean => {
    if (restoreReferences) {
      return true
    }
    let service: BuiltinLibraryReferenceService
    try {
      service = options.getReferenceService()
    } catch {
      return false
    }
    const original = service.createModelReference
    if (typeof original !== 'function') {
      return false
    }
    const createReference = function (
      this: BuiltinLibraryReferenceService,
      uri: Uri
    ): Promise<ModelReference> {
      const model = host.editor.getModel(uri)
      const entry = model ? owned.get(model) : undefined
      if (!entry || disposed) {
        return original.call(this, uri)
      }
      entry.references += 1
      reconcile()
      let released = false
      let referenceDisposed = false
      const release = (): void => {
        if (!released) {
          released = true
          entry.references -= 1
          reconcile()
        }
      }
      let request: Promise<ModelReference>
      try {
        request = original.call(this, uri)
      } catch (error) {
        release()
        throw error
      }
      return request.then(
        (reference) => ({
          object: reference.object,
          dispose() {
            if (!referenceDisposed) {
              referenceDisposed = true
              try {
                reference.dispose()
              } finally {
                release()
              }
            }
          }
        }),
        (error: unknown) => {
          release()
          throw error
        }
      )
    }
    service.createModelReference = createReference
    restoreReferences = () => {
      if (service.createModelReference === createReference) {
        service.createModelReference = original
      }
    }
    return true
  }

  const createModel = function (this: LibraryFactory, fileName: string): Model | null {
    const uri = host.Uri.parse(fileName)
    const existing = host.editor.getModel(uri)
    const builtin =
      this._hasFetchedLibFiles === true &&
      uri.scheme === 'file' &&
      uri.authority === '' &&
      uri.query === '' &&
      uri.fragment === '' &&
      uri.path.startsWith('/lib.') &&
      Object.hasOwn(options.libFileSet, uri.path.slice(1))
    const model = originalCreate.call(this, fileName)
    if (
      !existing &&
      builtin &&
      model &&
      !model.isDisposed() &&
      host.editor.getModel(uri) === model &&
      retainReferences()
    ) {
      const entry: Entry = { version: model.getVersionId(), references: 0, subscriptions: [] }
      owned.set(model, entry)
      entry.subscriptions.push(
        model.onDidChangeAttached(reconcile),
        model.onDidChangeContent(() => {
          forget(model)
          reconcile()
        })
      )
      reconcile()
    }
    return model
  }
  factory.getOrCreateModel = createModel
  const subscriptions = [
    host.editor.onDidCreateModel((model) => {
      if (owned.size > 0 && isScript(model.getLanguageId())) {
        reconcile()
      }
    }),
    host.editor.onWillDisposeModel((model) => {
      if (owned.has(model)) {
        forget(model)
      }
      if (owned.size > 0 && isScript(model.getLanguageId())) {
        reconcileAfterDisposal()
      }
    }),
    host.editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
      if (owned.has(model)) {
        forget(model)
      }
      if (owned.size > 0 && (isScript(oldLanguage) || isScript(model.getLanguageId()))) {
        reconcile()
      }
    })
  ]
  const unsubscribeSources = options.subscribeOpenSources(reconcile)

  return () => {
    disposed = true
    cancelTimer()
    if (factory.getOrCreateModel === createModel) {
      factory.getOrCreateModel = originalCreate
    }
    restoreReferences?.()
    unsubscribeSources()
    for (const subscription of subscriptions) {
      subscription.dispose()
    }
    for (const model of owned.keys()) {
      forget(model)
    }
    installed.delete(factory)
  }
}
