// Toolhelp denial may return an empty table; require the querying process to distinguish a readable snapshot.
export const SELF_PROCESS_ROW = {
  pid: process.pid,
  ppid: 0,
  name: 'vitest.exe',
  commandLine: 'vitest'
}
export const withSelf = <T>(rows: readonly T[]): (T | typeof SELF_PROCESS_ROW)[] => [
  SELF_PROCESS_ROW,
  ...rows
]

export type NativeProcessRow = {
  pid: number
  ppid: number
  name: string
  commandLine?: string
}

export const DEFAULT_WINDOWS_ROWS: NativeProcessRow[] = [
  {
    pid: 100,
    ppid: 99,
    name: 'powershell.exe',
    commandLine: 'powershell.exe'
  },
  {
    pid: 101,
    ppid: 100,
    name: 'node.exe',
    commandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'
  }
]
