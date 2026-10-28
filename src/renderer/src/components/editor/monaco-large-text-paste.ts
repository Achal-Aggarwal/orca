import type { editor } from 'monaco-editor'
import { Selection } from 'monaco-editor/esm/vs/editor/common/core/selection.js'
import { yieldToEventLoop } from '../../../../shared/event-loop-yield'
import { getUtf8ChunkEndIndex } from '../../../../shared/utf8-byte-limits'
import {
  measureTextControlPasteByteLength,
  measureTextControlPasteByteLengthWithYield
} from '@/lib/text-control-paste'

export const MONACO_PASTE_DIRECT_MAX_BYTES = 64 * 1024
export const MONACO_PASTE_CHUNK_MAX_BYTES = 16 * 1024
export const MONACO_PASTE_MAX_BYTES = 16 * 1024 * 1024

export type MonacoLargeTextPasteResult =
  | { status: 'ignored'; reason: 'already-handled' | 'empty' | 'small' | 'read-only' | 'no-editor' }
  | { status: 'handled' }
  | {
      status: 'pasted'
      mode: 'chunked'
      byteLength: number
      chunksWritten: number
    }
  | {
      status: 'rejected'
      reason: 'target-unavailable' | 'too-large'
      byteLength: number
      chunksWritten: 0
    }
  | {
      status: 'cancelled'
      reason: 'target-unavailable'
      byteLength: number
      chunksWritten: number
    }

export type MonacoLargeTextPasteOptions = {
  directMaxBytes?: number
  chunkMaxBytes?: number
  maxBytes?: number
  measureYieldAfterCodeUnits?: number
  readOnly?: boolean
  yieldToEventLoop?: () => Promise<void>
  onPasteStart?: () => void
  onPasteResult?: (
    result: Exclude<MonacoLargeTextPasteResult, { status: 'ignored' | 'handled' }>
  ) => void
}

// Accept base ICodeEditor methods for both focused context-menu editors and mounted standalone editors.
export type MonacoPasteEditor = Pick<
  editor.ICodeEditor,
  | 'getModel'
  | 'getContainerDomNode'
  | 'hasTextFocus'
  | 'getSelections'
  | 'executeEdits'
  | 'pushUndoStop'
>

type MonacoPasteSnapshot = {
  container: HTMLElement
  model: editor.ITextModel
}

function getPlainTextFromPasteEvent(event: ClipboardEvent): string {
  return event.clipboardData?.getData('text/plain') ?? ''
}

function snapshotMonacoPasteTarget(monacoEditor: MonacoPasteEditor): MonacoPasteSnapshot | null {
  const model = monacoEditor.getModel()
  const container = monacoEditor.getContainerDomNode()
  if (!model || !container.isConnected || !monacoEditor.hasTextFocus()) {
    return null
  }
  return { container, model }
}

function isMonacoPasteTargetCurrent(
  monacoEditor: MonacoPasteEditor,
  snapshot: MonacoPasteSnapshot
): boolean {
  return (
    monacoEditor.getModel() === snapshot.model &&
    monacoEditor.getContainerDomNode() === snapshot.container &&
    snapshot.container.isConnected &&
    monacoEditor.hasTextFocus()
  )
}

async function insertMonacoTextInChunks(
  monacoEditor: MonacoPasteEditor,
  text: string,
  byteLength: number,
  options: MonacoLargeTextPasteOptions
): Promise<Exclude<MonacoLargeTextPasteResult, { status: 'ignored' | 'handled' }>> {
  const snapshot = snapshotMonacoPasteTarget(monacoEditor)
  if (!snapshot) {
    return { status: 'rejected', reason: 'target-unavailable', byteLength, chunksWritten: 0 }
  }

  const chunkMaxBytes = Math.max(1, options.chunkMaxBytes ?? MONACO_PASTE_CHUNK_MAX_BYTES)
  let textIndex = 0
  let chunksWritten = 0
  monacoEditor.pushUndoStop()

  while (textIndex < text.length) {
    if (!isMonacoPasteTargetCurrent(monacoEditor, snapshot)) {
      monacoEditor.pushUndoStop()
      return { status: 'cancelled', reason: 'target-unavailable', byteLength, chunksWritten }
    }

    const selections = monacoEditor.getSelections()
    if (!selections?.length) {
      monacoEditor.pushUndoStop()
      return { status: 'cancelled', reason: 'target-unavailable', byteLength, chunksWritten }
    }

    const selectionChunkMaxBytes = Math.max(1, Math.floor(chunkMaxBytes / selections.length))
    const nextIndex = getUtf8ChunkEndIndex(text, textIndex, selectionChunkMaxBytes)
    const chunk = text.slice(textIndex, nextIndex)
    const chunkLength = chunk.replace(/\r\n|\r|\n/g, snapshot.model.getEOL()).length
    const orderedRanges = selections
      .map((selection, index) => ({
        index,
        start: snapshot.model.getOffsetAt(selection.getStartPosition()),
        end: snapshot.model.getOffsetAt(selection.getEndPosition())
      }))
      .sort((left, right) => left.start - right.start)
    // Model offsets account for earlier edits, EOL normalization and coalesced inverse operations.
    const endOffsets = selections.map(() => 0)
    let offsetDelta = 0
    for (const { start, end, index } of orderedRanges) {
      endOffsets[index] = start + offsetDelta + chunkLength
      offsetDelta += chunkLength - (end - start)
    }
    const accepted = monacoEditor.executeEdits(
      'orca-large-paste',
      selections.map((range) => ({ range, text: chunk, forceMoveMarkers: true })),
      () =>
        endOffsets.map((offset) => Selection.fromPositions(snapshot.model.getPositionAt(offset)))
    )
    if (!accepted) {
      monacoEditor.pushUndoStop()
      return { status: 'cancelled', reason: 'target-unavailable', byteLength, chunksWritten }
    }
    textIndex = nextIndex
    chunksWritten += 1

    if (textIndex < text.length) {
      await (options.yieldToEventLoop ?? yieldToEventLoop)()
    }
  }

  monacoEditor.pushUndoStop()
  return { status: 'pasted', mode: 'chunked', byteLength, chunksWritten }
}

// Share size rejection and chunking across DOM and context-menu paste paths.
export async function executeMonacoLargeTextPaste(
  monacoEditor: MonacoPasteEditor,
  text: string,
  options: MonacoLargeTextPasteOptions
): Promise<Exclude<MonacoLargeTextPasteResult, { status: 'ignored' | 'handled' }>> {
  const maxBytes = options.maxBytes ?? MONACO_PASTE_MAX_BYTES
  const byteLengthMeasurement = await measureTextControlPasteByteLengthWithYield(text, {
    stopAfterBytes: maxBytes,
    yieldAfterCodeUnits: options.measureYieldAfterCodeUnits,
    yieldToEventLoop: options.yieldToEventLoop
  })
  if (byteLengthMeasurement.exceededLimit) {
    return {
      status: 'rejected',
      reason: 'too-large',
      byteLength: byteLengthMeasurement.byteLength,
      chunksWritten: 0
    }
  }
  return insertMonacoTextInChunks(monacoEditor, text, byteLengthMeasurement.byteLength, options)
}

export function handleMonacoLargeTextPaste(
  monacoEditor: editor.IStandaloneCodeEditor | null,
  event: ClipboardEvent,
  options: MonacoLargeTextPasteOptions = {}
): MonacoLargeTextPasteResult {
  if (event.defaultPrevented) {
    return { status: 'ignored', reason: 'already-handled' }
  }
  if (options.readOnly) {
    return { status: 'ignored', reason: 'read-only' }
  }
  if (!monacoEditor?.getModel()) {
    return { status: 'ignored', reason: 'no-editor' }
  }

  const text = getPlainTextFromPasteEvent(event)
  if (!text) {
    return { status: 'ignored', reason: 'empty' }
  }

  const directMaxBytes = options.directMaxBytes ?? MONACO_PASTE_DIRECT_MAX_BYTES
  const maxBytes = options.maxBytes ?? MONACO_PASTE_MAX_BYTES
  const ownershipMeasurement = measureTextControlPasteByteLength(text, {
    stopAfterBytes: Math.min(directMaxBytes, maxBytes)
  })
  if (!ownershipMeasurement.exceededLimit) {
    return { status: 'ignored', reason: 'small' }
  }

  if (maxBytes <= directMaxBytes) {
    event.preventDefault()
    event.stopPropagation()
    const result = {
      status: 'rejected',
      reason: 'too-large',
      byteLength: ownershipMeasurement.byteLength,
      chunksWritten: 0
    } as const
    options.onPasteResult?.(result)
    return result
  }

  event.preventDefault()
  event.stopPropagation()

  options.onPasteStart?.()
  // Why the catch: a throwing paste must still settle, or its start-side state never releases.
  void executeMonacoLargeTextPaste(monacoEditor, text, options)
    .catch((error: unknown) => {
      console.error('[editor] large paste failed', error)
      return {
        status: 'cancelled',
        reason: 'target-unavailable',
        byteLength: ownershipMeasurement.byteLength,
        chunksWritten: 0
      } as const
    })
    .then(options.onPasteResult)
  return { status: 'handled' }
}
