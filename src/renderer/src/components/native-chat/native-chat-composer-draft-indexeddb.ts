// Keep persistence thin; the draft store owns merge and lifecycle policy.

import type {
  NativeChatComposerDraftStorage,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

const DATABASE_NAME = 'orca-native-chat-composer-drafts'
const DATABASE_VERSION = 2
const DRAFTS = 'drafts'
const SOURCES = 'terminal-paste-sources'
const REFERENCES = 'terminal-paste-references'
const STORES = [DRAFTS, SOURCES, REFERENCES]

function settled(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Resolves once the transaction is on disk; rejects when it aborts (a full disk included). */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('draft write aborted'))
  })
}

export function createIndexedDbNativeChatComposerDraftStorage(
  factory: IDBFactory
): NativeChatComposerDraftStorage {
  let opened: Promise<IDBDatabase> | null = null
  const database = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SOURCES)) {
          request.result.createObjectStore(SOURCES)
        }
        if (!request.result.objectStoreNames.contains(REFERENCES)) {
          const refs = request.result.createObjectStore(REFERENCES)
          refs.createIndex('scope', 'scope')
          refs.createIndex('source', 'id')
        }
        if (!request.result.objectStoreNames.contains(DRAFTS)) {
          request.result.createObjectStore(DRAFTS)
        }
      }
      request.onsuccess = () => {
        const db = request.result
        // Close replaced/upgraded connections so later writes reopen instead of reusing a dead database.
        db.onversionchange = () => {
          opened = null
          db.close()
        }
        db.onclose = () => {
          opened = null
        }
        resolve(db)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('draft database is blocked'))
    }).catch((error: unknown) => {
      opened = null
      throw error
    })
    return opened
  }

  const changeDraft = (
    transaction: IDBTransaction,
    scope: string,
    draft: StoredNativeChatComposerDraft | null,
    bodies: ReadonlyMap<string, string> = new Map()
  ): void => {
    const refs = transaction.objectStore(REFERENCES)
    const sources = transaction.objectStore(SOURCES)
    const drafts = transaction.objectStore(DRAFTS)
    const ids = new Set(
      (draft?.pastedTextSourceIds ?? []).filter((id) =>
        draft?.text.includes(`[Pasted text](orca-paste:${id})`)
      )
    )
    const previous = refs.index('scope').openCursor(scope)
    previous.onsuccess = () => {
      const cursor = previous.result
      if (!cursor) {
        return
      }
      const id: unknown = cursor.value.id
      if (typeof id === 'string' && !ids.has(id)) {
        cursor.delete()
        const remaining = refs.index('source').count(id)
        remaining.onsuccess = () => {
          if (remaining.result === 0) {
            sources.delete(id)
          }
        }
      }
      cursor.continue()
    }
    for (const id of ids) {
      refs.put({ scope, id }, [scope, id])
      const present = sources.getKey(id)
      present.onsuccess = () => {
        if (present.result !== undefined) {
          return
        }
        const text = bodies.get(id)
        if (text === undefined) {
          transaction.abort()
        } else {
          sources.put(text, id)
        }
      }
    }
    if (draft) {
      drafts.put(draft, scope)
    } else {
      drafts.delete(scope)
    }
  }
  let collection: Promise<void> | null = null
  let retryCollection = false
  const change = async (apply: (transaction: IDBTransaction) => void): Promise<void> => {
    const transaction = (await database()).transaction(STORES, 'readwrite')
    const done = committed(transaction)
    apply(transaction)
    await done
    if (retryCollection) {
      void collectSources().catch(() => {})
    }
  }
  const collect = async (): Promise<void> => {
    let after: IDBValidKey | undefined
    let more = true
    while (more) {
      const transaction = (await database()).transaction([SOURCES, REFERENCES], 'readwrite')
      const done = committed(transaction)
      const sources = transaction.objectStore(SOURCES)
      const refs = transaction.objectStore(REFERENCES).index('source')
      const page = sources.openKeyCursor(
        after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)
      )
      let count = 0
      more = false
      page.onsuccess = () => {
        const cursor = page.result
        if (!cursor) {
          return
        }
        after = cursor.key
        const owned = refs.count(cursor.key)
        owned.onsuccess = () => {
          if (!owned.result) {
            sources.delete(cursor.key)
          }
        }
        if (++count < 32) {
          cursor.continue()
        } else {
          more = true
        }
      }
      await done
    }
  }

  const collectSources = (): Promise<void> => {
    collection ??= collect()
      .then(
        () => {
          retryCollection = false
        },
        (error: unknown) => {
          retryCollection = true
          throw error
        }
      )
      .finally(() => {
        collection = null
      })
    return collection
  }

  return {
    loadAll: async () => {
      const drafts = (await database()).transaction(DRAFTS, 'readonly').objectStore(DRAFTS)
      const [keys, values] = await Promise.all([
        settled(drafts.getAllKeys()),
        settled(drafts.getAll())
      ])
      const loaded = new Map<string, unknown>()
      if (Array.isArray(keys) && Array.isArray(values)) {
        keys.forEach((key, index) => {
          if (typeof key === 'string') {
            loaded.set(key, values[index])
          }
        })
      }
      return loaded
    },
    read: async (scopeKey) =>
      settled((await database()).transaction(DRAFTS, 'readonly').objectStore(DRAFTS).get(scopeKey)),
    readSource: async (id) =>
      settled((await database()).transaction(SOURCES, 'readonly').objectStore(SOURCES).get(id)),
    write: (scopeKey, draft: StoredNativeChatComposerDraft, bodies) =>
      change((transaction) => changeDraft(transaction, scopeKey, draft, bodies)),
    remove: (scopeKeys) =>
      change((transaction) => {
        for (const scopeKey of scopeKeys) {
          changeDraft(transaction, scopeKey, null)
        }
      }),
    collectSources,
    update: async (scopeKey, apply) => {
      const transaction = (await database()).transaction(STORES, 'readwrite')
      const done = committed(transaction)
      const drafts = transaction.objectStore(DRAFTS)
      const read = drafts.get(scopeKey)
      // Why inside the read's callback: the write must land in the same transaction as the read.
      read.onsuccess = () => {
        const next = apply(read.result)
        changeDraft(transaction, scopeKey, next)
      }
      await done
    }
  }
}
