import { afterEach, expect, it, vi } from 'vitest'
import { initialize } from 'monaco-editor/esm/vs/common/initialize.js'
import { EditorWorker } from 'monaco-editor/esm/vs/editor/common/services/editorWebWorker.js'

vi.mock('monaco-editor/esm/vs/common/initialize.js', () => ({ initialize: vi.fn() }))

const originalRequest = EditorWorker.prototype.$fmr
const originalRemoved = EditorWorker.prototype.$acceptRemovedModel
const originalChanged = EditorWorker.prototype.$acceptModelChanged
const originalNew = EditorWorker.prototype.$acceptNewModel

afterEach(() => {
  EditorWorker.prototype.$fmr = originalRequest
  EditorWorker.prototype.$acceptRemovedModel = originalRemoved
  EditorWorker.prototype.$acceptModelChanged = originalChanged
  EditorWorker.prototype.$acceptNewModel = originalNew
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('synchronizes the installed compiler after native mirror retirement while reusing the live tree', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('self', {})
  await import('./monaco-typescript.worker')
  const start = self.onmessage
  if (!start) {
    throw new Error('Missing worker bootstrap')
  }
  start.call(self, new MessageEvent('message'))
  const factory = vi.mocked(initialize).mock.calls[0]?.[0]
  if (!factory) {
    throw new Error('Missing stock worker factory')
  }
  let readModels: EditorWorker['getModels'] = () => []
  const worker = factory(
    { getMirrorModels: () => readModels() },
    { compilerOptions: { noLib: true }, extraLibs: {}, inlayHintsOptions: {} }
  )
  const server = new EditorWorker(worker)
  readModels = () => server.getModels()
  for (const [name, text] of [
    ['live', 'export const live = 1'],
    ['retired', 'export const retired = 2']
  ]) {
    server.$acceptNewModel({ url: `file:///${name}.ts`, lines: [text], EOL: '\n', versionId: 1 })
  }
  expect(await server.$fmr('getQuickInfoAtPosition', ['file:///live.ts', 14])).toBeDefined()
  const service = worker.getLanguageService()
  const before = service.getProgram()
  const live = before?.getSourceFile('file:///live.ts')
  expect(live).toBeDefined()
  expect(before?.getSourceFile('file:///retired.ts')).toBeDefined()
  const synchronize = vi.spyOn(service, 'getProgram')
  server.$acceptRemovedModel('file:///retired.ts')
  await vi.advanceTimersByTimeAsync(59_999)
  expect(synchronize).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(synchronize).toHaveBeenCalledTimes(1)
  const after = synchronize.mock.results[0]?.value
  expect(after?.getSourceFile('file:///retired.ts')).toBeUndefined()
  expect(after?.getSourceFile('file:///live.ts')).toBe(live)
  expect(await server.$fmr('getQuickInfoAtPosition', ['file:///live.ts', 14])).toBeDefined()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(synchronize).toHaveBeenCalledTimes(1)
})
