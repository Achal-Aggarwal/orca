/** Git keeps the complete payload and removes only terminal CR/LF bytes. */
export function parseGitdirMarkerPayload(content: string): string | null {
  const prefix = 'gitdir: '
  return content.startsWith(prefix)
    ? content.slice(prefix.length).replace(/[\r\n]+$/, '') || null
    : null
}
