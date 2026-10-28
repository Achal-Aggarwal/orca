import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, it } from 'vitest'

it('keeps branch coverage after an iteration pass and never caches a timed-out gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-changed-gate-'))
  function git(...args) {
    const result = runProcessSync({ program: 'git', args, cwd: root })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  function check(...args) {
    return runProcessSync({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: [resolve('config/scripts/check-changed.mjs'), ...args, '--maxWorkers=2'],
      cwd: root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 30_000
    })
  }
  try {
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'core.autocrlf', 'false')
    writeFileSync(join(root, '.gitignore'), '.cache/\nconfig\nnode_modules\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    symlinkSync(resolve('config'), join(root, 'config'), 'junction')
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction')
    writeFileSync(join(root, 'committed.md'), '# Branch change\n')
    git('add', 'committed.md')
    git('commit', '-qm', 'branch change')

    const cleanIteration = check('--scope=worktree')
    expect(cleanIteration.code, cleanIteration.stderr).toBe(0)
    expect(cleanIteration.stdout).toContain('no changes against HEAD')

    writeFileSync(join(root, 'local.md'), '# Local change\n')
    const iteration = check('--scope=worktree')
    expect(iteration.code, iteration.stderr).toBe(0)
    expect(iteration.stdout).toContain('1 changed file(s) since HEAD')
    const iterationPass = readFileSync(join(root, '.cache/check-changed.json'), 'utf8')
    expect(check('--scope=worktree').stdout).toContain('nothing changed since last passing run')

    const timedOut = check(`--base=${base}`, '--stepTimeoutMs=1')
    expect(timedOut.code).toBe(1)
    expect(timedOut.stderr).toContain('Timed out after')
    expect(readFileSync(join(root, '.cache/check-changed.json'), 'utf8')).toBe(iterationPass)

    const branch = check(`--base=${base}`)
    expect(branch.code, branch.stderr).toBe(0)
    expect(branch.stdout).toContain('2 changed file(s)')
    expect(branch.stdout).not.toContain('nothing changed since last passing run')
    expect(check(`--base=${base}`).stdout).toContain('nothing changed since last passing run')
    expect(check('--scope=worktree').stdout).toContain('nothing changed since last passing run')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
