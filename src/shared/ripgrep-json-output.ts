import {
  createDenseRipgrepMatchJsonReader,
  parseRipgrepMatchJson,
  type RipgrepMatchMessage
} from './ripgrep-dense-match-json'
import type { JsonTextStructureLimits } from './json-text-structure-limit'

const BUFFERED_RECORD_CODE_UNITS = 64 * 1024
// Includes per-byte empty matches after the 5 MiB source limit's UTF-16 decoding expansion.
const MAX_RECORD_CODE_UNITS = 512 * 1024 * 1024

type DenseReader = ReturnType<typeof createDenseRipgrepMatchJsonReader>

export class RipgrepJsonOutputDecoder {
  private chunks: string[] = []
  private codeUnits = 0
  private reader: DenseReader | undefined
  private rejected = false

  constructor(
    private readonly options: {
      limits: JsonTextStructureLimits
      maxMatches: () => number
      onRecord: (message: RipgrepMatchMessage) => 'continue' | 'stop'
      onInvalid: () => void
    }
  ) {}

  push(chunk: string): 'continue' | 'stop' {
    if (this.options.maxMatches() <= 0) {
      this.clear()
      return 'stop'
    }
    let cursor = 0
    while (cursor < chunk.length) {
      const newline = chunk.indexOf('\n', cursor)
      const end = newline === -1 ? chunk.length : newline
      if (!this.rejected) {
        try {
          this.append(chunk.slice(cursor, end))
        } catch {
          this.reject()
        }
      }
      if (newline === -1) {
        return 'continue'
      }
      if (this.finish() === 'stop') {
        return 'stop'
      }
      cursor = newline + 1
    }
    return 'continue'
  }

  finish(): 'continue' | 'stop' {
    let message: RipgrepMatchMessage | undefined
    try {
      if (!this.rejected && this.codeUnits > 0) {
        message = this.reader
          ? this.reader.finish()
          : parseRipgrepMatchJson(
              this.chunks.join(''),
              this.options.maxMatches(),
              this.options.limits
            )
      }
    } catch {
      this.options.onInvalid()
    }
    this.clear()
    return message ? this.options.onRecord(message) : 'continue'
  }

  clear(): void {
    this.chunks = []
    this.codeUnits = 0
    this.reader = undefined
    this.rejected = false
  }

  private append(text: string): void {
    this.codeUnits += text.length
    if (this.codeUnits > MAX_RECORD_CODE_UNITS) {
      throw new RangeError('Search JSON record exceeds its code unit limit')
    }
    if (!this.reader && this.codeUnits <= BUFFERED_RECORD_CODE_UNITS) {
      this.chunks.push(text)
      return
    }
    if (!this.reader) {
      this.reader = createDenseRipgrepMatchJsonReader(
        this.options.maxMatches(),
        this.options.limits.nestingDepth
      )
      for (const chunk of this.chunks) {
        this.reader.write(chunk)
      }
      this.chunks = []
    }
    this.reader.write(text)
  }

  private reject(): void {
    this.chunks = []
    this.reader = undefined
    this.rejected = true
    this.options.onInvalid()
  }
}
