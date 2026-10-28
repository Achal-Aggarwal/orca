import { isStatelessRendererReplyCsiQuery } from '../../../../../shared/terminal-reply-query-extraction'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from '../../../../../shared/terminal-reply-query-scan'
import type { RuntimeTerminalDataMeta } from '../../../orca-runtime'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream, TerminalOutputChunk } from './terminal-stream-types'
import { encodeTerminalStreamText } from '../../../../../shared/terminal-stream-protocol'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'

// Why: half of fish's 10s DA1 wait (fish-shell src/input/decode.rs LONG_READ_TIMEOUT); older replies risk landing at a prompt as junk.
const YIELDED_QUERY_MAX_AGE_MS = 5_000
const YIELDED_QUERY_MAX_ENTRIES = 16

export type YieldedTerminalQuery = { seq: number; data: string; at: number }

/** Record stateless queries main yielded solely to this stream at ingestion, so a later discard can hand them back. */
export function recordYieldedTerminalQueries(
  runtime: TerminalMultiplexConnection['runtime'],
  stream: TerminalMultiplexStream,
  data: string,
  meta: RuntimeTerminalDataMeta | undefined
): void {
  if (
    stream.isMobile ||
    typeof meta?.seq !== 'number' ||
    !runtime.isSoleRemoteTerminalQueryOwner(stream.ptyId)
  ) {
    stream.yieldedQueryScan = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    return
  }
  // Why: frames split large events with per-slice seqs, so settle by each query's own end seq; transformed text can't map offsets to seq.
  const mapsToSeq = (meta.rawLength ?? data.length) === data.length
  const { queries, state } = scanTerminalReplyQuerySequences(
    data,
    meta.seq - data.length,
    mapsToSeq ? stream.yieldedQueryScan : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  )
  stream.yieldedQueryScan = mapsToSeq ? state : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  const at = Date.now()
  for (const query of queries) {
    if (query.data.startsWith('\x1b[') && isStatelessRendererReplyCsiQuery(query.data)) {
      stream.yieldedQueries.push({ seq: mapsToSeq ? query.endSeq : meta.seq, data: query.data, at })
    }
  }
  if (stream.yieldedQueries.length > YIELDED_QUERY_MAX_ENTRIES) {
    stream.yieldedQueries.splice(0, stream.yieldedQueries.length - YIELDED_QUERY_MAX_ENTRIES)
  }
}

export function settleDeliveredYieldedQueries(
  stream: TerminalMultiplexStream,
  deliveredSeq: number | undefined
): void {
  if (typeof deliveredSeq === 'number' && stream.yieldedQueries.length > 0) {
    stream.yieldedQueries = stream.yieldedQueries.filter((query) => query.seq > deliveredSeq)
  }
}

/** Snapshots preserve cells, not queries; replay covered stateless queries through the viewer's ordered parser. */
export function replaySnapshotCoveredStatelessQueries(
  connection: TerminalMultiplexConnection,
  stream: TerminalMultiplexStream,
  chunks: readonly TerminalOutputChunk[],
  snapshotSeq: number | undefined,
  pendingEscapeTailAnsi?: string
): void {
  if (typeof snapshotSeq !== 'number' || stream.yieldedQueries.length === 0) {
    return
  }
  const remainingQueries = [...stream.yieldedQueries]
  let scanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  let replayed = false
  for (const chunk of chunks) {
    const uncovered = getOutputAfterSnapshotSeq(chunk, snapshotSeq)
    const seq = chunk.meta?.seq
    if (typeof seq !== 'number' || uncovered === chunk) {
      scanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
      continue
    }
    const rawLength = chunk.meta?.rawLength ?? chunk.data.length
    const startSeq = seq - rawLength
    const coveredLength = chunk.data.length - (uncovered?.data.length ?? 0)
    const mapsToSeq = rawLength === chunk.data.length && !chunk.meta?.transformed
    const scan = scanTerminalReplyQuerySequences(
      chunk.data.slice(0, coveredLength),
      startSeq,
      mapsToSeq ? scanState : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    scanState = mapsToSeq ? scan.state : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    for (const query of scan.queries) {
      const querySeq = mapsToSeq ? query.endSeq : seq
      const owedIndex = remainingQueries.findIndex(
        (owed) => owed.seq === querySeq && owed.data === query.data
      )
      if (isStatelessRendererReplyCsiQuery(query.data) && owedIndex !== -1) {
        remainingQueries.splice(owedIndex, 1)
        const data = !replayed && pendingEscapeTailAnsi ? `\x18${query.data}` : query.data
        replayed = true
        // Seq-less output survives the viewer's snapshot cutoff; retain host-only settlement until actually sent.
        connection.queueOrSendOutput(stream, {
          bytes: encodeTerminalStreamText(data),
          displayLength: data.length,
          replayedQuery: { seq: querySeq, data: query.data }
        })
      }
    }
  }
  if (replayed && pendingEscapeTailAnsi) {
    // Cancel only the snapshot's partial parser command around queries, then restore it for the untouched live suffix.
    connection.queueOrSendOutput(stream, {
      bytes: encodeTerminalStreamText(pendingEscapeTailAnsi),
      displayLength: pendingEscapeTailAnsi.length
    })
  }
}

/** Main answers recent yielded queries the view will now never receive; each was owned by this stream alone. */
export function answerUndeliveredYieldedQueries(
  runtime: TerminalMultiplexConnection['runtime'],
  stream: TerminalMultiplexStream
): void {
  const cutoff = Date.now() - YIELDED_QUERY_MAX_AGE_MS
  const data = stream.yieldedQueries
    .filter((query) => query.at >= cutoff)
    .map((query) => query.data)
    .join('')
  stream.yieldedQueries = []
  stream.yieldedQueryScan = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  if (data) {
    runtime.answerYieldedTerminalQueries(stream.ptyId, data)
  }
}
