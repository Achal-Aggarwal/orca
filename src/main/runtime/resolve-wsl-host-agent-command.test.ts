import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveWslHostAgentCommand } from './wsl-host-agent-terminal-launch'
import * as wslModule from '../ipc/wsl-guest-windows-drive-path'

vi.mock('../ipc/wsl-guest-windows-drive-path', () => ({
  isWslHostOrcadProcess: vi.fn(),
  resolveGuestNativeProgram: vi.fn(),
  guestNativePathEnv: vi.fn((path) => path),
  guestNativeSpawnEnv: vi.fn((env) => env),
  readGuestWindowsDriveMounts: vi.fn(() => [])
}))

vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: vi.fn((cmd) => cmd)
}))

describe('resolveWslHostAgentCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns bare command on non-WSL platforms', () => {
    vi.mocked(wslModule.isWslHostOrcadProcess).mockReturnValue(false)

    const result = resolveWslHostAgentCommand('claude')
    expect(result).toBe('claude')
  })

  it('returns null when only Windows copy exists on WSL host', () => {
    vi.mocked(wslModule.isWslHostOrcadProcess).mockReturnValue(true)
    vi.mocked(wslModule.resolveGuestNativeProgram).mockReturnValue(null)

    const result = resolveWslHostAgentCommand('claude')
    expect(result).toBeNull()
  })

  it('returns absolute path when agent found in WSL distro', () => {
    vi.mocked(wslModule.isWslHostOrcadProcess).mockReturnValue(true)
    vi.mocked(wslModule.resolveGuestNativeProgram).mockReturnValue('/usr/local/bin/claude')

    const result = resolveWslHostAgentCommand('claude')
    expect(result).toBe('/usr/local/bin/claude')
  })

  it('returns bare command when found in PATH without absolute path', () => {
    vi.mocked(wslModule.isWslHostOrcadProcess).mockReturnValue(true)
    vi.mocked(wslModule.resolveGuestNativeProgram).mockReturnValue('claude')

    const result = resolveWslHostAgentCommand('claude')
    expect(result).toBe('claude')
  })

  it('passes cleaned PATH to resolveGuestNativeProgram', () => {
    vi.mocked(wslModule.isWslHostOrcadProcess).mockReturnValue(true)
    vi.mocked(wslModule.guestNativePathEnv).mockReturnValue('/usr/bin:/bin')
    vi.mocked(wslModule.resolveGuestNativeProgram).mockReturnValue('claude')

    resolveWslHostAgentCommand('claude', '/opt/windows:/usr/bin')

    expect(vi.mocked(wslModule.resolveGuestNativeProgram)).toHaveBeenCalledWith(
      'claude',
      { pathEnv: '/usr/bin:/bin' },
      expect.any(Function)
    )
  })

  it('desktop terminal launches are unchanged (non-WSL)', () => {
    vi.mocked(wslModule.isWslHostOrcadProcess).mockReturnValue(false)
    const result = resolveWslHostAgentCommand('cursor')
    expect(result).toBe('cursor')
  })

  it('native Linux terminal launches are unchanged (non-WSL)', () => {
    vi.mocked(wslModule.isWslHostOrcadProcess).mockReturnValue(false)
    const result = resolveWslHostAgentCommand('opencode')
    expect(result).toBe('opencode')
  })

  it('macOS terminal launches are unchanged (non-WSL)', () => {
    vi.mocked(wslModule.isWslHostOrcadProcess).mockReturnValue(false)
    const result = resolveWslHostAgentCommand('omp')
    expect(result).toBe('omp')
  })

  it('SSH terminal launches are unchanged (non-WSL)', () => {
    vi.mocked(wslModule.isWslHostOrcadProcess).mockReturnValue(false)
    const result = resolveWslHostAgentCommand('claude')
    expect(result).toBe('claude')
  })
})
