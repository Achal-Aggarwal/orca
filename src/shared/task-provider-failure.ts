export function taskProviderFailure(
  errorCode: string,
  error: string
): { ok: false; error: string; errorCode: string } {
  return { ok: false, error, errorCode }
}
