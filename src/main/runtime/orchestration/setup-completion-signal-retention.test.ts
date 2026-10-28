import { expect, it } from 'vitest'
import { createSetupCompletionScanner } from './setup-completion-signal'

function collectHeap(): number {
  const gc = globalThis.gc
  if (!gc) {
    throw new Error('Retention checks require --expose-gc')
  }
  void /reset/.test('reset')
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

it('keeps completion scanners without retaining their consumed output chunks', () => {
  const chunkChars = 1024 * 1024
  const count = 32
  for (let index = 0; index < 8; index += 1) {
    createSetupCompletionScanner('warmup', () => {}).scan('x'.repeat(chunkChars))
  }
  const scanners: ReturnType<typeof createSetupCompletionScanner>[] = []
  const completions: number[] = []
  const before = collectHeap()
  for (let index = 0; index < count; index += 1) {
    const scanner = createSetupCompletionScanner(`token-${index}`, (code) => completions.push(code))
    scanner.scan(String.fromCharCode(65 + (index % 26)).repeat(chunkChars))
    scanners.push(scanner)
  }
  const retained = collectHeap() - before

  expect(retained).toBeLessThan(4 * 1024 * 1024)
  for (const [index, scanner] of scanners.entries()) {
    scanner.scan('\r\n__ORCA_SETUP_COMP')
    scanner.scan(`LETE__:token-${index}:${index}\r`)
    scanner.scan('\n')
    scanner.scan(`__ORCA_SETUP_COMPLETE__:token-${index}:99\n`)
  }
  expect(completions).toEqual(Array.from({ length: count }, (_, index) => index))
})
