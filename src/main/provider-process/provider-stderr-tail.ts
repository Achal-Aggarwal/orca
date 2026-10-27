import { StringDecoder } from 'node:string_decoder'
import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import { stripAnsiControlSequences } from '../../shared/commit-message-agent-output'
import { redactString } from '../../shared/secret-redaction'

/** A byte-bounded stderr tail whose text is redacted for display. */
export function createProviderStderrTail(maxBytes: number) {
  let output = createOutputSink(maxBytes, 'tail')
  let line = createOutputSink(maxBytes)
  const decoder = new StringDecoder('utf8')
  let insidePem = false

  const finishLine = (separator: string): void => {
    const text = stripAnsiControlSequences(line.text())
    let omit = insidePem
    for (const marker of text.matchAll(/-----(BEGIN|END) [A-Z ]+-----/g)) {
      insidePem = marker[1] === 'BEGIN'
      omit = true
    }
    if (line.truncated()) {
      output = createOutputSink(maxBytes, 'tail')
    } else if (!omit) {
      output.write(text + separator)
    }
    line = createOutputSink(maxBytes)
  }

  return {
    write(chunk: Buffer | string): void {
      const text = decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      const parts = text.split(/(\r\n|[\r\n\u2028\u2029])/)
      for (let index = 0; index < parts.length; index += 2) {
        // One excess character detects overflow without retaining a giant backing buffer.
        line.write(parts[index].slice(0, maxBytes + 1))
        const separator = parts[index + 1]
        if (separator !== undefined) {
          finishLine(separator)
        }
      }
    },
    text(): string {
      if (line.truncated()) {
        return ''
      }
      const pending = stripAnsiControlSequences(line.text())
      const text =
        discardPartialLine(output.text(), output.truncated()) +
        (!insidePem && !/-----BEGIN [A-Z ]+-----/.test(pending) ? pending : '')
      const redacted = createOutputSink(maxBytes, 'tail')
      redacted.write(redactString(text))
      return discardPartialLine(redacted.text(), redacted.truncated())
    }
  }
}

// A truncated line may have lost the label needed to redact a secret.
function discardPartialLine(text: string, truncated: boolean): string {
  return truncated ? text.replace(/^[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)/, '') : text
}
