import { afterEach, expect, it, vi } from 'vitest'
import { workingSymlinkTargetForGit } from './working-symlink-target'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests
} from '../wsl-linked-worktree-git-routing'

afterEach(() => {
  vi.restoreAllMocks()
  resetWslLinkedWorktreeGitRoutingForTests()
})

it.each([
  [String.raw`..\targets\note.md`, '../targets/note.md'],
  [String.raw`C:\Folder\note.md`, 'C:/Folder/note.md'],
  [String.raw`\\?\C:\Folder\note.md`, 'C:/Folder/note.md'],
  [String.raw`\??\C:\Folder\note.md`, 'C:/Folder/note.md'],
  [String.raw`\\server\share\note.md`, '//server/share/note.md'],
  [String.raw`\\?\UNC\server\share\note.md`, '//server/share/note.md'],
  [String.raw`\??\UNC\server\share\note.md`, '//server/share/note.md'],
  [String.raw`\\?\unc\server\share\note.md`, '//server/share/note.md'],
  [String.raw`\??\UnC\server\share\note.md`, '//server/share/note.md'],
  [String.raw`\DosDevices\C:\Folder\note.md`, 'C:/Folder/note.md'],
  [String.raw`\dOsDeViCeS\uNc\server\share\note.md`, '//server/share/note.md'],
  [String.raw`UNC\relative\note.md`, 'UNC/relative/note.md'],
  [String.raw`\DosDevices-not-a-prefix\note.md`, '/DosDevices-not-a-prefix/note.md']
])('matches native Windows Git target spelling for %s', (target, expected) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  expect(workingSymlinkTargetForGit(target, String.raw`C:\repo`, {})).toBe(expected)
})

it.each(['linux', 'darwin'] as const)('preserves literal backslashes on %s', (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  expect(workingSymlinkTargetForGit(String.raw`../name\with\backslashes`, '/repo', {})).toBe(
    String.raw`../name\with\backslashes`
  )
})

it.each([
  [String.raw`C:\repo`, { wslDistro: 'Ubuntu' }],
  [String.raw`\\wsl.localhost\Ubuntu\home\repo`, {}]
])('preserves Linux target bytes when Git runs in WSL for %s', (worktreePath, options) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const target = String.raw`../name\with\backslashes`
  expect(workingSymlinkTargetForGit(target, worktreePath, options)).toBe(target)
})

it('uses native spelling for the host-Git linked-worktree exception', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const worktreePath = String.raw`C:\linked-worktree`
  seedWslLinkedWorktreeGitRoutingForTests(worktreePath)
  expect(
    workingSymlinkTargetForGit(String.raw`..\targets\note.md`, worktreePath, {
      wslDistro: 'Ubuntu'
    })
  ).toBe('../targets/note.md')
})
