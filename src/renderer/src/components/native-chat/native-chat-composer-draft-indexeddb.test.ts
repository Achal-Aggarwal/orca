// Count saves only after transaction completion; queued puts can still be lost before commit.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIndexedDbNativeChatComposerDraftStorage } from './native-chat-composer-draft-indexeddb'

type FakeTransaction = {
  oncomplete: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  error: Error | null
  objectStore: () => FakeStore
  commit: () => void
}
type FakeStore = {
  put: (value: unknown, key: string) => object
  delete: (key: string) => object
  get: (key: string) => { result: unknown; onsuccess: (() => void) | null }
}

function fakeDatabase(): {
  factory: IDBFactory
  transactions: FakeTransaction[]
  puts: unknown[]
} {
  const transactions: FakeTransaction[] = []
  const puts: unknown[] = []
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const store: FakeStore = {
        put: (value) => {
          puts.push(value)
          return {}
        },
        delete: () => ({}),
        index: () => ({
          openCursor: () => {
            const request: { result: null; onsuccess: (() => void) | null } = {
              result: null,
              onsuccess: null
            }
            queueMicrotask(() => request.onsuccess?.())
            return request
          }
        }),
        get: () => {
          const request: { result: unknown; onsuccess: (() => void) | null } = {
            result: undefined,
            onsuccess: null
          }
          queueMicrotask(() => request.onsuccess?.())
          return request
        }
      }
      const transaction: FakeTransaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        objectStore: () => store,
        commit: () => {}
      }
      transactions.push(transaction)
      return transaction
    }
  }
  const factory = {
    open: () => {
      const request: { result: typeof database; onsuccess: (() => void) | null } = {
        result: database,
        onsuccess: null
      }
      queueMicrotask(() => request.onsuccess?.())
      return request
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in exposing only the calls the adapter makes.
  return { factory: factory as unknown as IDBFactory, transactions, puts }
}

const DRAFT = { text: 'unsent', images: [], savedAt: 1 }
const settledYet = async (promise: Promise<void>): Promise<boolean> => {
  let settled = false
  void promise.then(() => (settled = true))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return settled
}

describe('the IndexedDB draft storage', () => {
  it('settles a write only when its transaction completes', async () => {
    const { factory, transactions, puts } = fakeDatabase()
    const write = createIndexedDbNativeChatComposerDraftStorage(factory).write('scope', DRAFT)

    expect(await settledYet(write)).toBe(false)
    expect(puts).toEqual([DRAFT])
    transactions[0]!.oncomplete?.()
    await expect(write).resolves.toBeUndefined()
  })

  it('settles a read-modify-write only when its transaction completes', async () => {
    const { factory, transactions, puts } = fakeDatabase()
    const update = createIndexedDbNativeChatComposerDraftStorage(factory).update(
      'scope',
      () => DRAFT
    )

    expect(await settledYet(update)).toBe(false)
    expect(puts).toEqual([DRAFT])
    transactions[0]!.oncomplete?.()
    await expect(update).resolves.toBeUndefined()
  })

  it('rejects a write whose transaction aborts, as on a full disk', async () => {
    const { factory, transactions } = fakeDatabase()
    const write = createIndexedDbNativeChatComposerDraftStorage(factory).write('scope', DRAFT)
    await new Promise((resolve) => setTimeout(resolve, 0))
    transactions[0]!.error = new Error('QuotaExceededError')
    transactions[0]!.onabort?.()

    await expect(write).rejects.toThrow('QuotaExceededError')
  })

  describe('through the draft store', () => {
    const loaded: { clearNativeChatComposerDraftsForTests: () => void }[] = []
    afterEach(() => {
      for (const store of loaded.splice(0)) {
        store.clearNativeChatComposerDraftsForTests()
      }
    })

    async function storeOn(factory: IDBFactory) {
      vi.resetModules()
      const storageModule = await import('./native-chat-composer-draft-storage')
      storageModule.setNativeChatComposerDraftStorageForTests(
        createIndexedDbNativeChatComposerDraftStorage(factory)
      )
      const store = await import('./native-chat-composer-draft-store')
      loaded.push(store)
      return { store, drafts: await import('./native-chat-draft-cache') }
    }

    it('reports a scope’s write settled true only at its transaction’s complete', async () => {
      const { factory, transactions } = fakeDatabase()
      const { store, drafts } = await storeOn(factory)
      // The fake cannot load, so append must atomically update storage before hydration finishes.
      void store.hydrateNativeChatComposerDrafts()
      drafts.appendNativeChatDraftCache('agent-session:s1', 'returned by Stop')
      const settled = store.nativeChatComposerDraftWriteSettled('agent-session:s1')

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(await settledYet(settled.then(() => {}))).toBe(false)
      const write = transactions.at(-1)!
      write.oncomplete?.()
      await expect(settled).resolves.toBe(true)
    })

    it('reports false when the scope’s transaction aborts', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { factory, transactions } = fakeDatabase()
      const { store, drafts } = await storeOn(factory)
      void store.hydrateNativeChatComposerDrafts()
      drafts.appendNativeChatDraftCache('agent-session:s1', 'returned by Stop')
      const settled = store.nativeChatComposerDraftWriteSettled('agent-session:s1')

      await new Promise((resolve) => setTimeout(resolve, 0))
      const write = transactions.at(-1)!
      write.error = new Error('QuotaExceededError')
      write.onabort?.()
      await expect(settled).resolves.toBe(false)
      warn.mockRestore()
    })
  })
})

// Exercise adapter requests against transactional stores; browser scheduling remains lifecycle QA.
function sourceDatabase() {
  const state = new Map<string, Map<string, unknown>>()
  const transactions: string[][] = []
  const sourceReads = vi.fn()
  const database = {
    transaction(names: string | string[], mode: string) {
      const included = typeof names === 'string' ? [names] : names
      transactions.push(included)
      const local = new Map(included.map((name) => [name, new Map(state.get(name))]))
      let pending = 0,
        aborted = false
      const transaction = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        error: new Error('draft write aborted'),
        abort() {
          aborted = true
          queueMicrotask(() => transaction.onabort?.())
        },
        objectStore(name: string) {
          const data = local.get(name)!
          const key = (value: unknown) => JSON.stringify(value)
          const request = <T>(run: () => T) => {
            const result = {
              result: undefined as T | undefined,
              onsuccess: null as (() => void) | null
            }
            pending++
            queueMicrotask(() => {
              if (!aborted) {
                result.result = run()
                result.onsuccess?.()
              }
              if (--pending === 0) {
                queueMicrotask(() => {
                  if (pending || aborted) {
                    return
                  }
                  if (mode === 'readwrite') {
                    for (const [store, values] of local) {
                      state.set(store, values)
                    }
                  }
                  transaction.oncomplete?.()
                })
              }
            })
            return result
          }
          return {
            put: (value: unknown, id: unknown) => request(() => data.set(key(id), value)),
            delete: (id: unknown) => request(() => data.delete(key(id))),
            get: (id: unknown) =>
              request(() => {
                if (name === 'terminal-paste-sources') {
                  sourceReads(id)
                }
                return data.get(key(id))
              }),
            getKey: (id: unknown) => request(() => (data.has(key(id)) ? id : undefined)),
            getAll: () => request(() => [...data.values()]),
            getAllKeys: () => request(() => [...data.keys()].map((id) => JSON.parse(id))),
            index: (field: string) => ({
              count: (id: unknown) =>
                request(
                  () =>
                    [...data.values()].filter(
                      (value) =>
                        typeof value === 'object' &&
                        value !== null &&
                        (field === 'source'
                          ? 'id' in value && value.id === id
                          : 'scope' in value && value.scope === id)
                    ).length
                ),
              openCursor: (scope: string) => {
                const entries = [...data].filter(
                  ([, value]) =>
                    typeof value === 'object' &&
                    value !== null &&
                    'scope' in value &&
                    value.scope === scope
                )
                let index = 0
                const next = (): object | null => {
                  const entry = entries[index++]
                  return entry
                    ? {
                        value: entry[1],
                        delete: () => request(() => data.delete(entry[0])),
                        continue: () => {
                          const step = request(next)
                          step.onsuccess = () => {
                            cursor.result = step.result
                            cursor.onsuccess?.()
                          }
                        }
                      }
                    : null
                }
                const cursor = request(next)
                return cursor
              }
            })
          }
        }
      }
      return transaction
    }
  }
  const factory = {
    open() {
      const request = { result: database, onsuccess: null as (() => void) | null }
      queueMicrotask(() => request.onsuccess?.())
      return request
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adapter fixture implements only exercised IDB calls.
  return { factory: factory as unknown as IDBFactory, state, transactions, sourceReads }
}

it('commits source/header/ref atomically and uses durable owners across two stale window adapters', async () => {
  const { factory, state, transactions, sourceReads } = sourceDatabase()
  const first = createIndexedDbNativeChatComposerDraftStorage(factory)
  const second = createIndexedDbNativeChatComposerDraftStorage(factory)
  const id = '00000000-0000-4000-8000-000000000001'
  const draft = { ...DRAFT, text: `[Pasted text](orca-paste:${id})`, pastedTextSourceIds: [id] }
  const text = 'x'.repeat(1024 * 1024)
  await first.write('first', draft, new Map([[id, text]]))
  expect(transactions[0]).toEqual(['drafts', 'terminal-paste-sources', 'terminal-paste-references'])
  await first.loadAll()
  expect(sourceReads).not.toHaveBeenCalled()
  await second.write('second', draft)
  await first.remove(['first'])
  expect(await second.readSource!(id)).toBe(text)
  // Missing source aborts the whole header/reference write; another window's accepted source stays.
  const missing = '00000000-0000-4000-8000-000000000002'
  await expect(
    first.write('broken', {
      ...draft,
      text: `[Pasted text](orca-paste:${missing})`,
      pastedTextSourceIds: [missing]
    })
  ).rejects.toThrow('aborted')
  expect(await first.read('broken')).toBeUndefined()
  expect(state.get('terminal-paste-references')?.size).toBe(1)
  await second.remove(['second'])
  expect(await first.readSource!(id)).toBeUndefined()
  expect(state.get('terminal-paste-references')?.size).toBe(0)
})
