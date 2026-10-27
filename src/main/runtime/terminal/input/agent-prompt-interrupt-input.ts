/** Incremental framing keeps pasted ETX distinct from target Ctrl-C, even across coalesced writes. */
export function agentPromptInterruptInput(interrupt: () => void): (data: string) => void {
  let pasted = false
  let prefix = ''
  return (data) => {
    for (const byte of data) {
      const marker = pasted ? '\x1b[201~' : '\x1b[200~'
      prefix += byte
      while (prefix && !marker.startsWith(prefix)) {
        if (!pasted && prefix[0] === '\x03') {
          interrupt()
        }
        prefix = prefix.slice(1)
      }
      if (prefix === marker) {
        pasted = !pasted
        prefix = ''
      }
    }
  }
}
