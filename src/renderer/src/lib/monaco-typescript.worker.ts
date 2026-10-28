import { initialize } from 'monaco-editor/esm/vs/common/initialize.js'
import { create } from 'monaco-editor/esm/vs/language/typescript/tsWorker.js'
import { EditorWorker } from 'monaco-editor/esm/vs/editor/common/services/editorWebWorker.js'
import { createMonacoTsProgramIdleRefresh } from './monaco-ts-program-idle-refresh'

let idle: ReturnType<typeof createMonacoTsProgramIdleRefresh> | undefined
let hasProgram = false
const originalRequest = EditorWorker.prototype.$fmr
EditorWorker.prototype.$fmr = function (method, args) {
  return idle
    ? idle.request(() => originalRequest.call(this, method, args))
    : originalRequest.call(this, method, args)
}
const originalRemoved = EditorWorker.prototype.$acceptRemovedModel
EditorWorker.prototype.$acceptRemovedModel = function (uri) {
  originalRemoved.call(this, uri)
  if (hasProgram) {
    idle?.retired()
  }
}
const originalChanged = EditorWorker.prototype.$acceptModelChanged
EditorWorker.prototype.$acceptModelChanged = function (uri, event) {
  originalChanged.call(this, uri, event)
  idle?.activity()
}
const originalNew = EditorWorker.prototype.$acceptNewModel
EditorWorker.prototype.$acceptNewModel = function (data) {
  originalNew.call(this, data)
  idle?.activity()
}

self.onmessage = () => {
  initialize((context, data) => {
    const worker = create(context, data)
    const originalRoots = worker.getScriptFileNames
    worker.getScriptFileNames = function () {
      hasProgram = true
      return originalRoots.call(this)
    }
    idle = createMonacoTsProgramIdleRefresh(() => {
      // The normal language-request synchronization releases departed roots while reusing live trees.
      try {
        worker.getLanguageService().getProgram()
      } catch {
        // A failed idle refresh must preserve the next ordinary language request.
      }
    })
    return worker
  })
}
