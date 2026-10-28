import type * as Monaco from 'monaco-editor'
import { LibFiles } from 'monaco-editor/esm/vs/language/typescript/languageFeatures.js'
import { libFileSet } from 'monaco-editor/esm/vs/language/typescript/lib/lib.index.js'
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'
import { ITextModelService } from 'monaco-editor/esm/vs/editor/common/services/resolverService.js'
import { useAppStore } from '@/store'
import { getEditorModelOwnerKey } from '@/components/editor/editor-model-owner'
import { toEditorModelUri } from '@/components/editor/editor-model-uri'
import {
  installMonacoBuiltinLibraryModelOwnership,
  type BuiltinLibraryReferenceService
} from './monaco-builtin-library-model-ownership'
import { TS_WORKER_IDLE_STOP_MS } from './monaco-ts-worker-idle-stop'

function isReferenceService(value: unknown): value is BuiltinLibraryReferenceService {
  return (
    typeof value === 'object' &&
    value !== null &&
    'createModelReference' in value &&
    typeof value.createModelReference === 'function'
  )
}

export function installMonacoBuiltinLibraryLifetime(monaco: typeof Monaco): () => void {
  return installMonacoBuiltinLibraryModelOwnership(monaco, {
    factory: LibFiles.prototype,
    libFileSet,
    getReferenceService: () => {
      const service = StandaloneServices.get(ITextModelService)
      if (!isReferenceService(service)) {
        throw new Error('Monaco model reference service is unavailable')
      }
      return service
    },
    isOpenSourceUri: (uri) => {
      const state = useAppStore.getState()
      return state.openFiles.some(
        (file) => toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state)) === uri
      )
    },
    subscribeOpenSources: (listener) =>
      useAppStore.subscribe((state, previous) => {
        if (state.openFiles !== previous.openFiles) {
          listener()
        }
      }),
    delayMs: TS_WORKER_IDLE_STOP_MS
  })
}
