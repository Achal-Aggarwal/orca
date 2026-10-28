import { expect } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, transformWithOxc, type Plugin } from 'vite'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import type {
  AgentSessionHistoryPage,
  AgentSessionQueuedMessage
} from '../../../../shared/agent-session-wire'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import fixture from './structured-agent-session-frozen57.test-fixture.json'

const PIN = '2ff42fd37c9511ed17d9a41bf9c03a817f63bccd'
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const PREFIX = '\0frozen57:'

// Reuse the retained exact-pin loader; every relative dependency stays at the release pin.
export async function loadFrozen57() {
  if (fixture.pin !== PIN) {
    throw new Error('Wrong frozen release fixture')
  }
  const bodies = new Map(
    Object.entries(fixture.modules).map(([path, entry]) => {
      if (createHash('sha256').update(entry.source).digest('hex') !== entry.sha256) {
        throw new Error(`Corrupt frozen source ${path}`)
      }
      return [path, entry.source]
    })
  )
  const manifest: Record<string, string> = {}
  function frozenPath(path: string): string {
    for (const name of [
      path,
      `${path}.ts`,
      `${path}.tsx`,
      `${path}/index.ts`,
      `${path}/index.tsx`
    ]) {
      if (bodies.has(name)) {
        return name
      }
    }
    throw new Error(`Missing immutable .57 module ${PIN}:${path}`)
  }
  const plugin: Plugin = {
    name: 'frozen57-first-party',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (source.startsWith(PREFIX)) {
        return `${PREFIX}${frozenPath(source.slice(PREFIX.length))}`
      }
      if (!importer?.startsWith(PREFIX)) {
        return null
      }
      const path = importer.slice(PREFIX.length)
      if (source.startsWith('.')) {
        return `${PREFIX}${frozenPath(posix.normalize(posix.join(posix.dirname(path), source)))}`
      }
      return this.resolve(source, `${ROOT}${path}`, { skipSelf: true })
    },
    async load(id) {
      if (!id.startsWith(PREFIX)) {
        return null
      }
      const path = id.slice(PREFIX.length)
      const code = bodies.get(path)
      if (code === undefined) {
        throw new Error(`Missing frozen source ${path}`)
      }
      manifest[path] = createHash('sha256').update(code).digest('hex')
      const result = await transformWithOxc(code, `${ROOT}${path}`, { tsconfig: false })
      return { code: result.code, map: result.map }
    }
  }
  // Transform/evaluate only: no listener, filesystem watcher, dependency optimizer or app.
  const server = await createServer({
    configFile: false,
    root: ROOT,
    plugins: [plugin],
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }
  })
  try {
    const projectionModule = await server.ssrLoadModule(
      `${PREFIX}src/shared/structured-agent-session-message-projection.ts`
    )
    const projection: {
      projectStructuredAgentSessionMessages: typeof projectStructuredAgentSessionMessages
    } = {
      projectStructuredAgentSessionMessages: projectionModule.projectStructuredAgentSessionMessages
    }
    const textModule = await server.ssrLoadModule(
      `${PREFIX}mobile/src/session/mobile-native-chat-message-plain-text.ts`
    )
    const text: { nativeChatMessagePlainText: (message: NativeChatMessage) => string } = {
      nativeChatMessagePlainText: textModule.nativeChatMessagePlainText
    }
    const transientModule = await server.ssrLoadModule(
      `${PREFIX}mobile/src/session/mobile-native-chat-render-data.ts`
    )
    const transient: {
      foldMobileNativeChatMessages: (
        messages: NativeChatMessage[],
        agent: 'codex'
      ) => NativeChatMessage[]
      buildMobileNativeChatTransientData: (input: {
        messages: NativeChatMessage[]
        folded: NativeChatMessage[]
        streaming: null
        pending: []
        imagePreviewsByMessageId: Record<string, string[]>
      }) => { data: NativeChatMessage[] }
    } = {
      foldMobileNativeChatMessages: transientModule.foldMobileNativeChatMessages,
      buildMobileNativeChatTransientData: transientModule.buildMobileNativeChatTransientData
    }
    const cardsModule = await server.ssrLoadModule(
      `${PREFIX}mobile/src/session/mobile-structured-queued-message-cards.ts`
    )
    const cards: {
      mobileQueuedMessageCards: (
        queue: readonly AgentSessionQueuedMessage[] | null,
        submissions: readonly Pick<AgentJournalSubmission, 'queuedMessageId' | 'dispatchState'>[],
        facts?: { agentWorking?: boolean }
      ) => {
        messageId: string
        state: string
        command?: true
        waitsForAgent?: true
        text: string
      }[]
    } = { mobileQueuedMessageCards: cardsModule.mobileQueuedMessageCards }
    return { ...projection, ...text, ...transient, ...cards, manifest, pin: PIN }
  } finally {
    await server.close()
  }
}

export function expectFrozenSource(
  frozen: Awaited<ReturnType<typeof loadFrozen57>>,
  page: Pick<AgentSessionHistoryPage, 'items' | 'submissions'>,
  id: string,
  body: AgentJournalMessageItem,
  present = true
) {
  const messages = frozen.projectStructuredAgentSessionMessages(page.items, [], page.submissions)
  const matching = messages.filter((message) => message.id === agentJournalSubmissionKey(id))
  expect(matching).toHaveLength(present ? 1 : 0)
  const source = matching[0]
  if (!present) {
    expect(source).toBeUndefined()
    return
  }
  expect(source).toMatchObject({
    id: agentJournalSubmissionKey(id),
    role: 'user',
    blocks: body.blocks
  })
  if (!source) {
    throw new Error('missing frozen source')
  }
  const prose = body.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n\n')
  expect(prose.trim()).not.toBe('')
  expect(frozen.nativeChatMessagePlainText(source)).toBe(prose)
  const previews = body.blocks.flatMap((block, index) =>
    block.type === 'image-ref' ? [`file:///device/original-${index}.png`] : []
  )
  const transient = frozen.buildMobileNativeChatTransientData({
    messages,
    folded: frozen.foldMobileNativeChatMessages(messages, 'codex'),
    streaming: null,
    pending: [],
    imagePreviewsByMessageId: { [source.id]: previews }
  })
  let image = 0
  expect(transient.data.find((message) => message.id === source.id)?.blocks).toEqual(
    body.blocks.map((block) =>
      block.type === 'image-ref' ? { ...block, url: previews[image++] } : block
    )
  )
}
